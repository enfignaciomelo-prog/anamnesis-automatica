/**
 * Integración real: PostgreSQL + Better Auth + correo de prueba.
 * Requiere TEST_DATABASE_URL (la CI levanta un PostgreSQL de servicio). Sin esa
 * variable la prueba se omite con un aviso; no se simula la base de datos.
 * Solo datos ficticios (dominio .invalid).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import JSZip from "jszip";
import type { ImportAnalysis, InterviewSnapshot, InterviewSummary, SessionInfo, TemplateDetail } from "../../shared/types";
import type { App } from "../../server/app";
import type { Config } from "../../server/config";

const DB = process.env.TEST_DATABASE_URL;
const PORT = 4190;
const BASE = `http://127.0.0.1:${PORT}`;
const skip = DB ? false : "TEST_DATABASE_URL no definido: se omite la integración con PostgreSQL (se ejecuta en la CI)";

let app: App;
let config: Config;
let offset = 0;

async function start() {
  const { createApp } = await import("../../server/app");
  const { setupReal } = await import("../../server/real/setup");
  const deps = await setupReal(config);
  app = createApp(config, { ...deps, now: () => Date.now() + offset });
  await new Promise<void>((r) => app.server.listen(PORT, "127.0.0.1", r));
  assert.equal((app.server.address() as AddressInfo).port, PORT);
}

class Client {
  jar = new Map<string, string>();
  get cookie() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}, redirect: RequestRedirect = "follow") {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(path.startsWith("http") ? path : BASE + path, {
      method,
      redirect,
      headers: {
        Origin: BASE,
        ...(body !== undefined ? { "Content-Type": isBuf ? "application/octet-stream" : "application/json" } : {}),
        ...(this.jar.size ? { Cookie: this.cookie } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : isBuf ? new Uint8Array(body as Buffer) : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (/Max-Age=0/i.test(c) || v === "") this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return res;
  }
  async json<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>) {
    const r = await this.req(method, path, body, extra);
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as T & { error?: string; code?: string } };
  }
}

async function outbox(to: string) {
  const r = await fetch(`${BASE}/api/dev/outbox?to=${encodeURIComponent(to)}`);
  return (await r.json()) as { kind: string; text: string }[];
}
const linkIn = (text: string) => /(https?:\/\/\S+)/.exec(text)![1];

async function account(email: string, password = "clave-ficticia-segura-1") {
  const c = new Client();
  const up = await c.json("POST", "/api/auth/sign-up/email", { name: `Prof ${email.split("@")[0]}`, email, password, callbackURL: "/" });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  // Sin verificar el correo no puede entrar.
  const early = await c.json("POST", "/api/auth/sign-in/email", { email, password });
  assert.equal(early.status, 403, JSON.stringify(early.body));
  const mail = (await outbox(email)).find((m) => m.kind === "verificacion");
  assert.ok(mail, "debe existir el correo de verificación en la bandeja de prueba");
  const v = await c.req("GET", linkIn(mail.text), undefined, {}, "manual");
  assert.ok([200, 302].includes(v.status), `verificación: ${v.status}`);
  const inn = await c.json("POST", "/api/auth/sign-in/email", { email, password });
  assert.equal(inn.status, 200, JSON.stringify(inn.body));
  return c;
}

async function finish(c: Client, templateId?: string) {
  const { body: s } = await c.json<InterviewSnapshot>("POST", "/api/interviews", { templateId });
  await c.json("POST", `/api/interviews/${s.id}/consent`, { givenBy: "paciente" });
  await c.json("POST", `/api/interviews/${s.id}/command`, { command: "iniciar" });
  for (let i = 0; i < 150; i++) {
    const { body } = await c.json<InterviewSnapshot>("GET", `/api/interviews/${s.id}`);
    if (body.status === "detenida") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const [speaker, role] of [[1, "profesional"], [2, "paciente"], [3, "acompanante"]] as const)
    await c.json("POST", `/api/interviews/${s.id}/speakers`, { speaker, role });
  const { body } = await c.json<InterviewSnapshot>("GET", `/api/interviews/${s.id}`);
  for (const f of Object.values(body.fields).filter((x) => x.status === "requiere_revision"))
    await c.json("POST", `/api/interviews/${s.id}/fields/${f.fieldId}/confirm`, { value: null });
  const fin = await c.json<InterviewSnapshot>("POST", `/api/interviews/${s.id}/finalize`, { attested: true });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  return s.id;
}

describe("PostgreSQL + Better Auth (integración real)", { skip }, () => {
  const run = randomBytes(4).toString("hex");
  const emailA = `a-${run}@prueba.invalid`;
  const emailB = `b-${run}@prueba.invalid`;
  let a: Client;
  let b: Client;
  let templateId: string;
  let interviewId: string;

  before(async () => {
    const { loadConfig } = await import("../../server/config");
    const { setLogSink } = await import("../../server/log");
    setLogSink(() => undefined);
    config = loadConfig({
      DEMO_MODE: "false",
      NODE_ENV: "test",
      DATABASE_URL: DB,
      DATABASE_SSL: "disable",
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      BETTER_AUTH_URL: BASE,
      EMAIL_TRANSPORT: "prueba",
      DEMO_SPEED: "100",
      STATIC_DIR: "public",
      OCR: "false",
    });
    await start();
  });
  after(async () => {
    await app?.close();
  });

  it("registro con verificación de correo obligatoria y sesión desde el servidor", async () => {
    a = await account(emailA);
    b = await account(emailB);
    const s = await a.json<SessionInfo>("GET", "/api/session");
    assert.equal(s.status, 200);
    assert.equal(s.body.authMode, "cuentas");
    assert.equal(s.body.professional.email, emailA);
    assert.ok([...a.jar.keys()].some((k) => k.includes("session_token")), [...a.jar.keys()].join(","));
  });

  it("guarda plantillas, archivos y anamnesis por propietario", async () => {
    const up = await a.json<ImportAnalysis>("POST", "/api/templates/import", readFileSync("tests/fixtures/ficha-demo.docx"), {
      "X-File-Name": "ficha-demo.docx",
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const sections: { title: string; fields: unknown[] }[] = [];
    for (const c of up.body.candidates.filter((x) => x.include)) {
      let s = sections.find((x) => x.title === c.section);
      if (!s) sections.push((s = { title: c.section, fields: [] }));
      s.fields.push({ label: c.label, concept: c.concept, target: c.target });
    }
    const t = await a.json<TemplateDetail>("POST", `/api/templates/import/${up.body.importId}/confirm`, { name: "Ficha DEMO", sections });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    templateId = t.body.id;
    interviewId = await finish(a, templateId);
  });

  it("otro profesional no accede aunque cambie la URL o los identificadores", async () => {
    for (const [m, p] of [
      ["GET", `/api/interviews/${interviewId}`],
      ["GET", `/api/interviews/${interviewId}/export?format=original`],
      ["GET", `/api/interviews/${interviewId}/events`],
      ["DELETE", `/api/interviews/${interviewId}`],
      ["GET", `/api/templates/${templateId}`],
      ["DELETE", `/api/templates/${templateId}`],
    ] as const) {
      const r = await b.req(m, p);
      assert.equal(r.status, 404, `${m} ${p}`);
      await r.body?.cancel();
    }
    const list = await b.json<InterviewSummary[]>("GET", "/api/interviews");
    assert.ok(!list.body.some((i) => i.id === interviewId));
  });

  it("tras reiniciar el servidor, la plantilla, su archivo y la anamnesis siguen y se pueden exportar", async () => {
    await app.close();
    await start();
    const t = await a.json<TemplateDetail>("GET", `/api/templates/${templateId}`);
    assert.equal(t.status, 200);
    const s = await a.json<InterviewSnapshot>("GET", `/api/interviews/${interviewId}`);
    assert.equal(s.body.status, "finalizada");
    const r = await a.req("GET", `/api/interviews/${interviewId}/export?format=original`);
    assert.equal(r.status, 200);
    const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
    assert.match(await zip.file("word/document.xml")!.async("string"), /Refiere/);
    // Nueva entrevista con la plantilla guardada, después del reinicio.
    const again = await a.json<InterviewSnapshot>("POST", "/api/interviews", { templateId });
    assert.equal(again.status, 201);
    assert.equal(again.body.template.id, templateId);
  });

  it("recuperación de contraseña: revoca sesiones y exige la nueva clave", async () => {
    const anon = new Client();
    const rq = await anon.json("POST", "/api/auth/request-password-reset", { email: emailB, redirectTo: "/restablecer" });
    assert.equal(rq.status, 200, JSON.stringify(rq.body));
    const mail = (await outbox(emailB)).find((m) => m.kind === "restablecer");
    assert.ok(mail);
    const go = await anon.req("GET", linkIn(mail.text), undefined, {}, "manual");
    assert.equal(go.status, 302);
    const token = new URL(go.headers.get("location")!, BASE).searchParams.get("token");
    assert.ok(token);
    const rs = await anon.json("POST", "/api/auth/reset-password", { newPassword: "otra-clave-ficticia-2", token });
    assert.equal(rs.status, 200, JSON.stringify(rs.body));
    assert.equal((await b.json("GET", "/api/session")).status, 401, "la sesión anterior queda revocada");
    const old = await new Client().json("POST", "/api/auth/sign-in/email", { email: emailB, password: "clave-ficticia-segura-1" });
    assert.notEqual(old.status, 200);
    const fresh = await new Client().json("POST", "/api/auth/sign-in/email", { email: emailB, password: "otra-clave-ficticia-2" });
    assert.equal(fresh.status, 200);
  });

  it("corte diario: el servidor revoca la sesión en PostgreSQL y conserva las anamnesis", async () => {
    const s = await a.json<SessionInfo>("GET", "/api/session");
    offset = Date.parse(s.body.cutoffAt) - Date.now() + 1000;
    const r = await a.json("GET", "/api/interviews");
    assert.equal(r.body.error, "sesion_vencida");
    offset = 0;
    assert.equal((await a.json("GET", "/api/session")).body.error, "sin_sesion");
    const again = new Client();
    const inn = await again.json("POST", "/api/auth/sign-in/email", { email: emailA, password: "clave-ficticia-segura-1" });
    assert.equal(inn.status, 200);
    const list = await again.json<InterviewSummary[]>("GET", "/api/interviews?estado=revisada");
    assert.ok(list.body.some((i) => i.id === interviewId), "lo guardado permanece en la cuenta");
  });
});
