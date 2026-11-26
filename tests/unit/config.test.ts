import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../server/config";

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
    const c = loadConfig({ ...real, NODE_ENV: "production", RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.invalid" });
    assert.equal(c.email?.transport, "resend");
    assert.equal(c.database?.ssl, "require");
  });
  it("exige https y un secreto largo en producción", () => {
    assert.throws(() => loadConfig({ ...real, BETTER_AUTH_URL: "http://x.invalid", NODE_ENV: "production", RESEND_API_KEY: "k", EMAIL_FROM: "a@b.invalid" }), /https/);
    assert.throws(() => loadConfig({ ...real, BETTER_AUTH_SECRET: "corto" }), /32 caracteres/);
    assert.throws(() => loadConfig({ DEMO_MODE: "false" }), /DATABASE_URL/);
  });
  it("el modo demo sigue siendo el predeterminado", () => {
    assert.equal(loadConfig({}).demo, true);
  });
});
