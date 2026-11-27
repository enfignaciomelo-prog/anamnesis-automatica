/**
 * Conexión a PostgreSQL y migraciones. Todo en el esquema "anamnesis".
 * Supabase: usar la cadena del «Session pooler» (IPv4) y SSL.
 */
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import type { Config } from "../config";
import { logError, logEvent } from "../log";
import { pgTlsOptions } from "./ssl";

export const SCHEMA = "anamnesis";
const LOCK_ID = 727_274;

export function createPool(db: NonNullable<Config["database"]>): pg.Pool {
  const { connectionString, ssl } = pgTlsOptions(db);
  const pool = new pg.Pool({ connectionString, ssl, max: 10, idleTimeoutMillis: 30_000 });
  pool.on("connect", (client) => {
    client.query(`SET search_path TO ${SCHEMA}`).catch((e) => logError("db_search_path", e));
  });
  pool.on("error", (e) => logError("db_pool", e));
  return pool;
}

/** Migraciones: primero las de Better Auth (tablas de cuentas), luego las propias. */
export async function migrate(pool: pg.Pool, runAuthMigrations: () => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    await runAuthMigrations();
    await client.query(
      "CREATE TABLE IF NOT EXISTS aa_schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const dir = new URL("./migrations/", import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const id = f.replace(/\.sql$/, "");
      const done = await client.query("SELECT 1 FROM aa_schema_migrations WHERE id = $1", [id]);
      if (done.rowCount) continue;
      const sql = await readFile(new URL(f, dir), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO aa_schema_migrations (id) VALUES ($1)", [id]);
        await client.query("COMMIT");
        logEvent("db_migration_applied", { id });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
