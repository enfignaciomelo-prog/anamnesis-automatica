import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../server/config";
import { pgTlsOptions, stripSslParams } from "../../server/real/ssl";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfiction\n-----END CERTIFICATE-----";
const prod = { NODE_ENV: "production", RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.invalid", DATABASE_CA_CERT: PEM };

const real = {
  DEMO_MODE: "false",
  DATABASE_URL: "postgres://u:p@db.invalid:5432/x",
  BETTER_AUTH_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "https://anamnesis.invalid",
};

describe("configuración del modo con cuentas", () => {
  it("en producción no permite el correo de prueba (no se desactiva la verificación)", () => {
    assert.throws(() => loadConfig({ ...real, NODE_ENV: "production", EMAIL_TRANSPORT: "prueba" }), /no se permite en producción/);
  });
  it("exige Resend fuera del modo de prueba", () => {
    assert.throws(() => loadConfig({ ...real, NODE_ENV: "production" }), /RESEND_API_KEY/);
    const c = loadConfig({ ...real, ...prod });
    assert.equal(c.email?.transport, "resend");
    assert.equal(c.database?.ssl, "verify");
  });
  it("exige https y un secreto largo en producción", () => {
    assert.throws(() => loadConfig({ ...real, ...prod, BETTER_AUTH_URL: "http://x.invalid" }), /https/);
    assert.throws(() => loadConfig({ ...real, BETTER_AUTH_SECRET: "corto" }), /32 caracteres/);
    assert.throws(() => loadConfig({ DEMO_MODE: "false" }), /DATABASE_URL/);
  });
  it("el modo demo sigue siendo el predeterminado", () => {
    assert.equal(loadConfig({}).demo, true);
  });
});

describe("TLS de PostgreSQL", () => {
  it("en producción rechaza DATABASE_SSL=disable", () => {
    assert.throws(() => loadConfig({ ...real, ...prod, DATABASE_SSL: "disable" }), /DATABASE_SSL=disable/);
  });
  it("usa las raíces de Node si no se configura una CA y valida el formato de la CA explícita", () => {
    const config = loadConfig({ ...real, ...prod, DATABASE_CA_CERT: "" });
    assert.deepEqual(pgTlsOptions(config.database!).ssl, { rejectUnauthorized: true });
    assert.throws(() => loadConfig({ ...real, ...prod, DATABASE_CA_CERT: "no es pem" }), /PEM/);
  });
  it("en producción rechaza sslmode que no verifica en la URL", () => {
    for (const mode of ["disable", "allow", "prefer", "no-verify"])
      assert.throws(
        () => loadConfig({ ...real, ...prod, DATABASE_URL: `postgres://u:p@db.invalid:5432/x?sslmode=${mode}` }),
        /sslmode/,
        mode,
      );
  });
  it("rechaza parámetros que desactivan TLS incluso si se repiten", () => {
    for (const query of ["ssl=0", "ssl=false", "sslmode=verify-full&sslmode=disable"]) {
      assert.throws(() => loadConfig({ ...real, ...prod, DATABASE_URL: `${real.DATABASE_URL}?${query}` }), /TLS verificado/);
    }
  });
  it("nunca genera rejectUnauthorized:false y elimina parámetros ssl de la URL", () => {
    const withCa = pgTlsOptions({ url: "postgres://u:p@h:5432/d?sslmode=no-verify&sslrootcert=x", ssl: "verify", caCert: PEM });
    assert.deepEqual(withCa.ssl, { ca: PEM, rejectUnauthorized: true });
    assert.ok(!/ssl/.test(withCa.connectionString), withCa.connectionString);
    const noCa = pgTlsOptions({ url: "postgres://u:p@h:5432/d", ssl: "verify" });
    assert.deepEqual(noCa.ssl, { rejectUnauthorized: true });
    assert.equal(pgTlsOptions({ url: "postgres://u:p@localhost:5432/d", ssl: "disable" }).ssl, false);
    assert.deepEqual(stripSslParams("postgres://u:p@h/d?ssl=0&sslmode=disable&x=1").removed, ["sslmode", "ssl"]);
  });
  it("fuera de producción permite desactivar TLS solo para PostgreSQL local de pruebas", () => {
    const c = loadConfig({ ...real, DATABASE_SSL: "disable", EMAIL_TRANSPORT: "prueba" });
    assert.equal(c.database?.ssl, "disable");
    assert.throws(() => loadConfig({ ...real, DATABASE_SSL: "require", EMAIL_TRANSPORT: "prueba" }), /DATABASE_SSL/);
  });
});
