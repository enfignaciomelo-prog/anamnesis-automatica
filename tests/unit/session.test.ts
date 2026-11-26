/**
 * Reglas de sesión exigidas en el servidor: corte diario 23:59 America/Santiago,
 * bloqueo por inactividad, cierre de sesión que conserva lo guardado, filtros
 * de «Mis anamnesis» y autoguardado del borrador. Reloj del servidor simulado.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { nextDailyCutoff } from "../../shared/cutoff";
import type { InterviewSnapshot, InterviewSummary, SessionInfo } from "../../shared/types";
import { type App, createApp } from "../../server/app";
import { loadConfig } from "../../server/config";
import { setLogSink } from "../../server/log";

let offset = 0;
let app: App;
let base: string;

before(async () => {
  setLogSink(() => undefined);
  app = createApp(loadConfig({ DEMO_SPEED: "100", STATIC_DIR: "public" }), { now: () => Date.now() + offset });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => app.close());
beforeEach(() => {
  offset = 0;
});

class Client {
  cookie = "";
  lastHeaders = new Headers();
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    this.lastHeaders = res.headers;
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = /Max-Age=0/.test(sc) ? "" : sc.split(";")[0];
    return res;
  }
  async json<T>(method: string, path: string, body?: unknown) {
    const r = await this.req(method, path, body);
    return { status: r.status, body: (await r.json()) as T & { error?: string } };
  }
}

async function login(perfil = "demo-a") {
  const c = new Client();
  await c.req("POST", "/api/demo/session", { perfil });
  return c;
}

describe("corte diario en el servidor", () => {
  it("informa el corte de la sesión y lo hace cumplir sin depender del navegador", async () => {
    const c = await login();
    const s = await c.json<SessionInfo>("GET", "/api/session");
    assert.equal(s.status, 200);
    const cutoff = Date.parse(s.body.cutoffAt);
    assert.equal(cutoff, nextDailyCutoff(Date.now() - 2000) > cutoff ? cutoff : nextDailyCutoff(Date.now()));
    // El servidor llega al corte (la cookie del navegador sigue presente).
    offset = cutoff - Date.now() + 1000;
    const r = await c.json("GET", "/api/interviews");
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "sesion_vencida");
    assert.match(c.lastHeaders.get("clear-site-data") ?? "", /storage/);
    // La sesión quedó revocada: no sirve aunque se reenvíe la cookie anterior.
    const again = await c.json("GET", "/api/session");
    assert.equal(again.body.error, "sin_sesion");
  });

  it("al volver a entrar después del corte, la sesión pertenece al período siguiente (sin bucle)", async () => {
    const c0 = await login();
    const first = await c0.json<SessionInfo>("GET", "/api/session");
    offset = Date.parse(first.body.cutoffAt) - Date.now() + 5000;
    const c = new Client();
    // La nueva sesión se crea con el reloj real; se simula que es posterior al corte
    // desplazando su inicio.
    await c.req("POST", "/api/demo/session", { perfil: "demo-a" });
    const sid = c.cookie.split("=")[1];
    (app.gate as unknown as { shiftSession(id: string, ms: number): void }).shiftSession(sid, offset);
    const s = await c.json<SessionInfo>("GET", "/api/session");
    assert.equal(s.status, 200);
    assert.ok(Date.parse(s.body.cutoffAt) > Date.parse(first.body.cutoffAt));
    assert.equal((await c.json("GET", "/api/interviews")).status, 200);
  });
});

describe("bloqueo por inactividad", () => {
  it("bloquea tras el tiempo configurado; consultar el estado no cuenta como actividad", async () => {
    const c = await login("demo-b");
    await c.json("PATCH", "/api/settings", { idleMinutes: 5 });
    offset = 4 * 60_000;
    assert.equal((await c.json("GET", "/api/session")).status, 200);
    offset = 6 * 60_000;
    const r = await c.json("GET", "/api/interviews");
    assert.equal(r.body.error, "bloqueo_inactividad");
    offset = 0;
    const bad = await (await login("demo-b")).json("PATCH", "/api/settings", { idleMinutes: 2 });
    assert.equal(bad.status, 400);
  });

  it("mientras escucha una entrevista no se bloquea", async () => {
    const c = await login("demo-b");
    await c.json("PATCH", "/api/settings", { idleMinutes: 5 });
    const { body } = await c.json<InterviewSnapshot>("POST", "/api/interviews", {});
    await c.json("POST", `/api/interviews/${body.id}/consent`, { givenBy: "paciente" });
    await c.json("POST", `/api/interviews/${body.id}/command`, { command: "iniciar" });
    await c.json("POST", `/api/interviews/${body.id}/command`, { command: "pausar" });
    await c.json("POST", `/api/interviews/${body.id}/command`, { command: "reanudar" });
    offset = 10 * 60_000;
    const r = await c.json<InterviewSnapshot>("GET", `/api/interviews/${body.id}`);
    assert.equal(r.status, 200, String(r.body.error));
    await c.json("POST", `/api/interviews/${body.id}/command`, { command: "detener" });
  });
});

describe("cierre de sesión y datos guardados", () => {
  it("cierra la sesión, pausa la escucha y conserva las anamnesis en el servidor", async () => {
    const c = await login();
    const { body } = await c.json<InterviewSnapshot>("POST", "/api/interviews", {});
    await c.json("POST", `/api/interviews/${body.id}/consent`, { givenBy: "paciente" });
    await c.json("POST", `/api/interviews/${body.id}/command`, { command: "iniciar" });
    await c.json("POST", `/api/interviews/${body.id}/command`, { command: "pausar" });
    await c.json("POST", `/api/interviews/${body.id}/command`, { command: "reanudar" });
    const out = await c.req("POST", "/api/logout", {});
    assert.equal(out.status, 200);
    assert.match(out.headers.get("clear-site-data") ?? "", /cache/);
    assert.equal((await c.json("GET", `/api/interviews/${body.id}`)).status, 401);
    const c2 = await login();
    const r = await c2.json<InterviewSnapshot>("GET", `/api/interviews/${body.id}`);
    assert.equal(r.status, 200);
    assert.ok(["pausada", "detenida"].includes(r.body.status), r.body.status);
    if (r.body.status === "pausada") assert.equal(r.body.pauseReason, "manual");
  });
});

describe("Mis anamnesis: filtros y autoguardado", () => {
  it("filtra por estado y fecha (hora de Chile) y solo muestra las propias", async () => {
    const c = await login("demo-b");
    const { body } = await c.json<InterviewSnapshot>("POST", "/api/interviews", {});
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
    let list = await c.json<InterviewSummary[]>("GET", `/api/interviews?estado=borrador&desde=${today}&hasta=${today}`);
    assert.ok(list.body.some((i) => i.id === body.id));
    assert.ok(list.body.every((i) => i.updatedAt));
    list = await c.json<InterviewSummary[]>("GET", "/api/interviews?estado=revisada");
    assert.ok(!list.body.some((i) => i.id === body.id));
    list = await c.json<InterviewSummary[]>("GET", "/api/interviews?desde=2020-01-01&hasta=2020-01-02");
    assert.equal(list.body.length, 0);
    const other = await login("demo-a");
    const theirs = await other.json<InterviewSummary[]>("GET", "/api/interviews");
    assert.ok(!theirs.body.some((i) => i.id === body.id));
  });

  it("autoguarda el texto en edición sin confirmarlo, y confirmar lo limpia", async () => {
    const c = await login("demo-b");
    const { body } = await c.json<InterviewSnapshot>("POST", "/api/interviews", {});
    const d = await c.json<{ savedAt: string }>("POST", `/api/interviews/${body.id}/fields/motivo/draft`, { value: "Texto a medio escribir" });
    assert.equal(d.status, 200);
    assert.ok(d.body.savedAt);
    let s = (await c.json<InterviewSnapshot>("GET", `/api/interviews/${body.id}`)).body;
    assert.equal(s.fields.motivo.draftValue, "Texto a medio escribir");
    assert.equal(s.fields.motivo.status, "no_referido");
    s = (await c.json<InterviewSnapshot>("POST", `/api/interviews/${body.id}/fields/motivo/confirm`, { value: "Control" })).body;
    assert.equal(s.fields.motivo.draftValue, null);
    assert.equal(s.fields.motivo.status, "confirmado");
    // Otro profesional no puede escribir borradores ajenos.
    const other = await login("demo-a");
    assert.equal((await other.json("POST", `/api/interviews/${body.id}/fields/motivo/draft`, { value: "x" })).status, 404);
  });
});
