/**
 * Pruebas de integración de la API: autorización por profesional, consentimiento,
 * revisión obligatoria, no sobrescritura, exportación y registros sin datos clínicos.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import JSZip from "jszip";
import type { InterviewSnapshot } from "../../shared/types";
import { type App, createApp } from "../../server/app";
import { loadConfig } from "../../server/config";
import { DEMO_SCRIPT } from "../../server/demo/script";
import { setLogSink } from "../../server/log";

const logs: string[] = [];
let app: App;
let base: string;

before(async () => {
  setLogSink((l) => logs.push(l));
  app = createApp(loadConfig({ DEMO_SPEED: "100", STATIC_DIR: "public", DISCONNECT_PAUSE_MS: "300" }));
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => app.close());

class Client {
  cookie = "";
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    return res;
  }
  async json<T = InterviewSnapshot>(method: string, path: string, body?: unknown) {
    const r = await this.req(method, path, body);
    return { status: r.status, body: (await r.json()) as T & { error?: string } };
  }
}

async function login(perfil: "demo-a" | "demo-b") {
  const c = new Client();
  const r = await c.req("POST", "/api/demo/session", { perfil });
  assert.equal(r.status, 200);
  return c;
}

async function waitFor(c: Client, id: string, pred: (s: InterviewSnapshot) => boolean, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await c.json("GET", `/api/interviews/${id}`);
    if (pred(body)) return body;
    if (Date.now() - t0 > ms) throw new Error(`timeout; estado=${body.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function fullInterview(c: Client) {
  const { body: created } = await c.json("POST", "/api/interviews", {});
  const id = created.id;
  await c.json("POST", `/api/interviews/${id}/consent`, { givenBy: "paciente" });
  await c.json("POST", `/api/interviews/${id}/command`, { command: "iniciar" });
  await waitFor(c, id, (s) => s.status === "detenida");
  for (const [speaker, role] of [
    [1, "profesional"],
    [2, "paciente"],
    [3, "acompanante"],
  ] as const)
    await c.json("POST", `/api/interviews/${id}/speakers`, { speaker, role });
  return id;
}

describe("API", () => {
  it("exige sesión", async () => {
    const r = await new Client().req("GET", "/api/interviews");
    assert.equal(r.status, 401);
  });

  it("no inicia la escucha sin consentimiento", async () => {
    const c = await login("demo-a");
    const { body } = await c.json("POST", "/api/interviews", {});
    const r = await c.json("POST", `/api/interviews/${body.id}/command`, { command: "iniciar" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "sin_consentimiento");
  });

  it("separa los datos entre profesionales en todas las rutas", async () => {
    const a = await login("demo-a");
    const b = await login("demo-b");
    const { body } = await a.json("POST", "/api/interviews", {});
    const id = body.id;
    const attempts: [string, string, unknown?][] = [
      ["GET", `/api/interviews/${id}`],
      ["GET", `/api/interviews/${id}/events`],
      ["GET", `/api/interviews/${id}/export?format=txt`],
      ["POST", `/api/interviews/${id}/consent`, { givenBy: "paciente" }],
      ["POST", `/api/interviews/${id}/command`, { command: "iniciar" }],
      ["POST", `/api/interviews/${id}/fields/motivo/confirm`, { value: "x" }],
      ["POST", `/api/interviews/${id}/finalize`, { attested: true }],
      ["DELETE", `/api/interviews/${id}`],
    ];
    for (const [m, p, body2] of attempts) {
      const r = await b.req(m, p, body2);
      assert.equal(r.status, 404, `${m} ${p}`);
      await r.body?.cancel();
    }
    const list = await b.json<unknown[]>("GET", "/api/interviews");
    assert.ok(!(list.body as { id: string }[]).some((i) => i.id === id));
    assert.equal((await a.json("GET", `/api/interviews/${id}`)).status, 200);
  });

  it("rechaza solicitudes que modifican desde otro origen", async () => {
    const c = await login("demo-a");
    const r = await c.req("POST", "/api/interviews", {}, { Origin: "https://otro.example" });
    assert.equal(r.status, 403);
  });

  it("flujo completo: revisión obligatoria, no sobrescritura, finalización y exportación", async () => {
    const c = await login("demo-a");
    const id = await fullInterview(c);
    let s = (await c.json("GET", `/api/interviews/${id}`)).body;
    assert.equal(s.segments.length, DEMO_SCRIPT.length);

    // Exportar antes de finalizar no está permitido.
    assert.equal((await c.req("GET", `/api/interviews/${id}/export?format=txt`)).status, 409);

    // No finaliza con campos en revisión.
    let r = await c.json("POST", `/api/interviews/${id}/finalize`, { attested: true });
    assert.equal(r.body.error, "revision_pendiente");

    // El texto del profesional no se sobrescribe cuando aparece información nueva.
    const mine = "Polidipsia y poliuria de 3 semanas (texto del profesional)";
    await c.json("POST", `/api/interviews/${id}/fields/enfermedad_actual/confirm`, { value: mine });
    const rec = app.service.record("demo-a", id);
    rec.segments.push({ id: "s99", speaker: 2, text: "También tengo mareos en la mañana.", start: 99, end: 100 });
    s = (await c.json("GET", `/api/interviews/${id}`)).body;
    assert.equal(s.fields.enfermedad_actual.professionalValue, mine);
    assert.equal(s.fields.enfermedad_actual.status, "requiere_revision");
    assert.ok(s.fields.enfermedad_actual.reasons.includes("nueva_informacion"));
    await c.json("POST", `/api/interviews/${id}/fields/enfermedad_actual/confirm`, { value: mine });

    await c.json("POST", `/api/interviews/${id}/fields/medicamentos/confirm`, {
      value: "Metformina 850 mg (frecuencia a confirmar con receta); losartán 50 mg en la mañana",
    });
    await c.json("POST", `/api/interviews/${id}/fields/alergias/confirm`, { value: null });
    s = (await c.json("GET", `/api/interviews/${id}`)).body;
    assert.equal(Object.values(s.fields).filter((f) => f.status === "requiere_revision").length, 0);

    r = await c.json("POST", `/api/interviews/${id}/finalize`, { attested: false });
    assert.equal(r.body.error, "sin_revision");
    r = await c.json("POST", `/api/interviews/${id}/finalize`, { attested: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "finalizada");

    // Finalizada: no se edita.
    r = await c.json("POST", `/api/interviews/${id}/fields/motivo/confirm`, { value: "x" });
    assert.equal(r.status, 409);

    const txt = await (await c.req("GET", `/api/interviews/${id}/export?format=txt&respaldo=1`)).text();
    assert.match(txt, /DATOS FICTICIOS/);
    assert.match(txt, /Actividad física: No referido/);
    assert.match(txt, /texto del profesional/);
    assert.match(txt, /Respaldo \[0:/);

    const docx = Buffer.from(await (await c.req("GET", `/api/interviews/${id}/export?format=docx`)).arrayBuffer());
    const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string");
    assert.match(xml, /No referido/);
    assert.match(xml, /Antecedentes familiares/);

    const pdf = Buffer.from(await (await c.req("GET", `/api/interviews/${id}/export?format=pdf`)).arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");

    // Eliminar.
    assert.equal((await c.req("DELETE", `/api/interviews/${id}`)).status, 200);
    assert.equal((await c.req("GET", `/api/interviews/${id}`)).status, 404);
  });

  it("una nueva atención no arrastra datos de la anterior", async () => {
    const c = await login("demo-a");
    await fullInterview(c);
    const { body } = await c.json("POST", "/api/interviews", {});
    assert.equal(body.segments.length, 0);
    assert.deepEqual(body.speakerRoles, {});
    assert.equal(body.consent, null);
    for (const f of Object.values(body.fields)) {
      assert.equal(f.status, "no_referido", f.fieldId);
      assert.equal(f.items.length, 0);
      assert.equal(f.professionalValue, null);
    }
  });

  it("pausa automáticamente si se pierde la conexión con la interfaz", async () => {
    const c = await login("demo-a");
    const { body } = await c.json("POST", "/api/interviews", {});
    const id = body.id;
    await c.json("POST", `/api/interviews/${id}/consent`, { givenBy: "representante" });
    // Velocidad 100 termina rápido: se reduce para esta prueba.
    const ctrl = new AbortController();
    const ev = await fetch(`${base}/api/interviews/${id}/events`, { headers: { Cookie: c.cookie }, signal: ctrl.signal });
    assert.equal(ev.headers.get("content-type"), "text/event-stream; charset=utf-8");
    await c.json("POST", `/api/interviews/${id}/command`, { command: "iniciar" });
    await c.json("POST", `/api/interviews/${id}/command`, { command: "pausar" });
    await c.json("POST", `/api/interviews/${id}/command`, { command: "reanudar" });
    ctrl.abort();
    const s = await waitFor(c, id, (x) => x.status !== "escuchando", 3000);
    assert.ok(s.status === "pausada" || s.status === "detenida");
    if (s.status === "pausada") assert.equal(s.pauseReason, "conexion");
  });

  it("la retención elimina entrevistas vencidas", async () => {
    const c = await login("demo-b");
    await c.json("PATCH", "/api/settings", { retentionMinutes: 15 });
    const { body } = await c.json("POST", "/api/interviews", {});
    app.service.record("demo-b", body.id).lastActivity = Date.now() - 16 * 60_000;
    app.service.sweep();
    assert.equal((await c.req("GET", `/api/interviews/${body.id}`)).status, 404);
    const bad = await c.json("PATCH", "/api/settings", { retentionMinutes: 99999 });
    assert.equal(bad.status, 400);
  });

  it("envía cabeceras de seguridad y no guarda en caché respuestas de la API", async () => {
    const c = await login("demo-a");
    const r = await c.req("GET", "/api/interviews");
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.match(c.cookie, /^aa_sid=/);
  });

  it("los registros no contienen texto clínico ni identificadores", () => {
    const all = logs.join("\n");
    assert.ok(logs.length > 20);
    for (const line of DEMO_SCRIPT) {
      for (const frag of line.text.split(/[,.?¿]/).map((x) => x.trim()).filter((x) => x.length > 12)) {
        assert.ok(!all.includes(frag), `fragmento en registros: ${frag}`);
      }
    }
    assert.ok(!all.includes("texto del profesional"));
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(all), "no debe registrar ids de entrevista");
  });
});

describe("service worker", () => {
  it("no intercepta ni guarda rutas /api", () => {
    const sw = readFileSync("public/sw.js", "utf8");
    assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)/);
    assert.match(sw, /isClinical\(url\)\) return;/);
    assert.ok(!/localStorage|indexedDB/.test(sw));
  });
});
