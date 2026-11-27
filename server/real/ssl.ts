/**
 * Opciones TLS para PostgreSQL. Nunca se usa rejectUnauthorized:false.
 *
 * - Producción: TLS obligatorio con verificación del certificado del servidor
 *   con las raíces de Node o la CA de DATABASE_CA_CERT. Se rechaza DATABASE_SSL=disable.
 * - Fuera de producción (CI y desarrollo local): se permite desactivar TLS para
 *   un PostgreSQL local; si se usa TLS, siempre se verifica.
 *
 * Los parámetros ssl* de la URL se eliminan: node-postgres los aplicaría por
 * encima de esta configuración (p. ej., sslmode=no-verify desactivaría la verificación).
 */
import type { ConnectionOptions } from "node:tls";

export interface DbTlsInput {
  url: string;
  ssl: "disable" | "verify";
  caCert?: string;
}

const URL_SSL_PARAMS = ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "sslpassword", "uselibpqcompat"];

export function stripSslParams(raw: string): { url: string; removed: string[] } {
  const u = new URL(raw);
  const removed = URL_SSL_PARAMS.filter((p) => u.searchParams.has(p));
  for (const p of removed) u.searchParams.delete(p);
  return { url: u.toString(), removed };
}

export function pgTlsOptions(db: DbTlsInput): { connectionString: string; ssl: false | ConnectionOptions } {
  const { url } = stripSslParams(db.url);
  if (db.ssl === "disable") return { connectionString: url, ssl: false };
  // Verificación siempre activa: con la CA indicada o las raíces de confianza de Node.
  return { connectionString: url, ssl: db.caCert ? { ca: db.caCert, rejectUnauthorized: true } : { rejectUnauthorized: true } };
}
