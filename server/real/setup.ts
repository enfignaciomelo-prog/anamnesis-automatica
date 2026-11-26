/** Arranque del modo con cuentas: PostgreSQL, migraciones, Better Auth y correo. */
import type { AppDeps } from "../app";
import { type Mailer, ResendMailer, TestMailer } from "../auth/mailer";
import type { Config } from "../config";
import { BetterAuthGate, createBetterAuth, runAuthMigrations } from "./betterAuth";
import { createPool, migrate } from "./db";
import { PgStore } from "./pgStore";

export async function setupReal(config: Config): Promise<Required<Pick<AppDeps, "store" | "gate">> & { mailer: Mailer }> {
  const pool = createPool(config.database!);
  const mailer: Mailer =
    config.email!.transport === "prueba" ? new TestMailer() : new ResendMailer(config.email!.resendKey!, config.email!.from!);
  const auth = createBetterAuth(pool, config, mailer);
  await migrate(pool, () => runAuthMigrations(auth));
  const store = new PgStore(pool, {
    retentionMinutes: config.retentionDefaultMinutes,
    idleMinutes: config.idleDefaultMinutes,
  });
  const gate = new BetterAuthGate(auth, pool, mailer, !config.production);
  return { store, gate, mailer };
}
