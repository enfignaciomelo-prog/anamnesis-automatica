/**
 * Llenado con Claude a través de la API, con un proveedor SIMULADO y la
 * transcripción ficticia de la demostración (sin llamadas externas).
 * Cubre: propuestas con respaldo, descarte de respaldos inválidos, fallo del
 * proveedor con continuación manual, respuesta tardía después de una edición
 * manual, cierre de sesión, corte diario y cambio de versión de la transcripción.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { InterviewSnapshot } from "../../shared/types";
import { nextDailyCutoff } from "../../shared/cutoff";
import { type App, createApp } from "../../server/app";
import { loadConfig } from "../../server/config";
import { type FillProvider, FillProviderError, type FillRequest } from "../../server/extraction/fillProvider";
import { setLogSink } from "../../server/log";

const logs: string[] = [];

class FakeProvider implements FillProvider {
  readonly model = "simulado";
  calls: FillRequest[] = [];
  aborted = 0;
  next: (req: FillRequest) => Promise<unknown> = async () => ({ propuestas: [] });
  fill(req: FillRequest, signal: AbortSignal) {
    this.calls.push(req);
    signal.addEventListener("abort", () => this.aborted++);
    return this.next(req);
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Respuesta del modelo construida desde los segmentos reales de la transcripción ficticia. */
function proposals(req: FillRequest) {
  const find = (re: RegExp) => req.segments.find((s) => re.test(s.text))!;
  const meds = find(/Metformina de 850/);
  const comp = find(/subió la metformina/);
  const alerg = find(/a ninguno que yo sepa/);
  const alergQ = find(/alérgica a algún medicamento/);
  const fam = find(/Mi mamá era diabética/);
  const motivo = find(/mucha sed/);
  return {
    propuestas: [
      { campo: "motivo", valor: "Mucha sed y orina harto hace tres semanas", clasificacion: "actual", clave: null, duda: false,
        respaldos: [{ segmento: motivo.id, cita: "ando con mucha sed y orino harto, hace como tres semanas" }] },
      { campo: "medicamentos", valor: "Metformina de 850 dos veces al día", clasificacion: "actual", clave: "metformina", duda: false,
        respaldos: [{ segmento: meds.id, cita: "Metformina de 850, dos veces al día" }] },
      { campo: "medicamentos", valor: "Metformina tres veces al día", clasificacion: "actual", clave: "metformina", duda: false,
        respaldos: [{ segmento: comp.id, cita: "el doctor le subió la metformina a tres veces al día" }] },
      { campo: "alergias", valor: "No es alérgica a medicamentos", clasificacion: "negado", clave: null, duda: true,
        // Respuesta breve: la pregunta del profesional se cita como contexto.
        respaldos: [{ segmento: alergQ.id, cita: "¿Es alérgica a algún medicamento?" }, { segmento: alerg.id, cita: "No, a ninguno que yo sepa" }] },
      { campo: "familiares", valor: "Mamá diabética", clasificacion: "familiar", clave: null, duda: false,
        respaldos: [{ segmento: fam.id, cita: "Mi mamá era diabética" }] },
      // Inválidas: cita inventada, diagnóstico no expresado, campo ajeno.
      { campo: "quirurgicos", valor: "Colecistectomía", clasificacion: "historico", clave: null, duda: false,
        respaldos: [{ segmento: meds.id, cita: "me sacaron la vesícula en 2010" }] },
      { campo: "morbidos", valor: "Diabetes mellitus tipo 2", clasificacion: "actual", clave: null, duda: false,
        respaldos: [{ segmento: find(/diabetes hace ocho años/).id, cita: "tengo diabetes hace ocho años" }] },
      { campo: "diagnostico", valor: "Diabetes descompensada", clasificacion: "actual", clave: null, duda: false,
        respaldos: [{ segmento: motivo.id, cita: "mucha sed" }] },
    ],
  };
}

let clock = 0;
const now = () => Date.now() + clock;
let fake: FakeProvider;
let app: App;
let base: string;

before(async () => {
  setLogSink((l) => logs.push(l));
  fake = new FakeProvider();
  app = createApp(loadConfig({ DEMO_SPEED: "100", STATIC_DIR: "public", DISCONNECT_PAUSE_MS: "300" }), {
    fillProvider: fake,
    now,
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => app.close());

class Client {
  cookie = "";
  async json<T = InterviewSnapshot>(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    return { status: res.status, body: (await res.json()) as T & { error?: string } };
  }
}

async function login(perfil: "demo-a" | "demo-b") {
  const c = new Client();
  assert.equal((await c.json("POST", "/api/demo/session", { perfil })).status, 200);
  return c;
}

async function waitFor(c: Client, id: string, pred: (s: InterviewSnapshot) => boolean, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await c.json("GET", `/api/interviews/${id}`);
    if (pred(body)) return body;
    if (Date.now() - t0 > ms) throw new Error(`timeout; estado=${body.status} ia=${body.ai?.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function stoppedInterview(c: Client) {
  const { body } = await c.json("POST", "/api/interviews", {});
  await c.json("POST", `/api/interviews/${body.id}/consent`, { givenBy: "paciente" });
  await c.json("POST", `/api/interviews/${body.id}/command`, { command: "iniciar" });
  await waitFor(c, body.id, (s) => s.status === "detenida");
  for (const [speaker, role] of [[1, "profesional"], [2, "paciente"], [3, "acompanante"]] as const)
    await c.json("POST", `/api/interviews/${body.id}/speakers`, { speaker, role });
  return body.id;
}

describe("llenado con Claude por la API (proveedor simulado)", () => {
  it("aplica solo propuestas con respaldo literal, muestra contradicciones y exige revisión", async () => {
    const c = await login("demo-a");
    const id = await stoppedInterview(c);
    const before = (await c.json("GET", `/api/interviews/${id}`)).body;
    assert.equal(before.ai?.status, "sin_solicitar");
    assert.equal(before.fields.motivo.status, "no_referido", "sin reglas: nada propuesto antes de pedirlo");

    fake.next = async (req) => proposals(req);
    const r = await c.json("POST", `/api/interviews/${id}/ai`, {});
    assert.equal(r.status, 202);
    const s = await waitFor(c, id, (x) => x.ai?.status === "listo");
    assert.equal(s.ai?.accepted, 5);
    assert.equal(s.ai?.discarded, 3);
    assert.match(s.ai?.message ?? "", /3 propuesta\(s\) se descartaron/);

    // Usa la transcripción definitiva y la versión de plantilla de la entrevista.
    const call = fake.calls.at(-1)!;
    assert.equal(call.segments.length, s.segments.length);
    assert.equal(call.template.version, s.template.version);

    assert.equal(s.fields.motivo.status, "propuesto");
    assert.equal(s.fields.motivo.items[0].evidence[0].quote, "ando con mucha sed y orino harto, hace como tres semanas");
    assert.equal(s.fields.quirurgicos.status, "no_referido", "cita inventada descartada");
    assert.equal(s.fields.morbidos.status, "no_referido", "diagnóstico no expresado descartado");
    assert.equal(s.fields.medicamentos.status, "requiere_revision");
    assert.ok(s.fields.medicamentos.reasons.includes("contradiccion"));
    assert.equal(s.fields.medicamentos.items.length, 2, "ambas versiones visibles");
    assert.equal(s.fields.alergias.status, "requiere_revision");
    assert.equal(s.fields.familiares.items[0].classification, "familiar");

    // No se finaliza sin revisar lo crítico.
    const fin = await c.json("POST", `/api/interviews/${id}/finalize`, { attested: true });
    assert.equal(fin.status, 409);
    assert.equal(fin.body.error, "revision_pendiente");
    await c.json("POST", `/api/interviews/${id}/fields/medicamentos/confirm`, { value: "Metformina (dosis por confirmar con receta)" });
    await c.json("POST", `/api/interviews/${id}/fields/alergias/confirm`, { value: null });
    assert.equal((await c.json("POST", `/api/interviews/${id}/finalize`, { attested: true })).status, 200);
  });

  it("si el proveedor falla, informa el error y se puede completar manualmente", async () => {
    const c = await login("demo-a");
    const id = await stoppedInterview(c);
    fake.next = async () => {
      throw new FillProviderError("Claude no está disponible en este momento. Puedes completar los campos manualmente.", "api_529");
    };
    await c.json("POST", `/api/interviews/${id}/ai`, {});
    const s = await waitFor(c, id, (x) => x.ai?.status === "error");
    assert.match(s.ai?.message ?? "", /manualmente/);
    assert.equal(s.fields.motivo.status, "no_referido");
    const m = await c.json("POST", `/api/interviews/${id}/fields/motivo/confirm`, { value: "DEMO: sed y poliuria" });
    assert.equal(m.body.fields.motivo.professionalValue, "DEMO: sed y poliuria");
    assert.equal((await c.json("POST", `/api/interviews/${id}/finalize`, { attested: true })).status, 200);
  });

  it("una respuesta inválida no aplica nada y se informa", async () => {
    const c = await login("demo-a");
    const id = await stoppedInterview(c);
    fake.next = async () => ({ resultado: "texto libre" });
    await c.json("POST", `/api/interviews/${id}/ai`, {});
    const s = await waitFor(c, id, (x) => x.ai?.status === "error");
    assert.match(s.ai?.message ?? "", /respuesta inválida/);
    assert.ok(Object.values(s.fields).every((f) => f.items.length === 0));
  });

  it("respuesta tardía después de una edición manual: el texto del profesional se conserva", async () => {
    const c = await login("demo-a");
    const id = await stoppedInterview(c);
    const d = deferred<unknown>();
    fake.next = () => d.promise;
    await c.json("POST", `/api/interviews/${id}/ai`, {});
    assert.equal((await c.json("POST", `/api/interviews/${id}/ai`, {})).status, 409, "una solicitud a la vez");
    // Mientras Claude responde, el profesional corrige el motivo.
    const edit = await c.json("POST", `/api/interviews/${id}/fields/motivo/confirm`, { value: "DEMO: control de diabetes" });
    assert.equal(edit.status, 200);
    d.resolve(proposals(fake.calls.at(-1)!));
    const s = await waitFor(c, id, (x) => x.ai?.status === "listo");
    assert.equal(s.fields.motivo.professionalValue, "DEMO: control de diabetes", "no se sobrescribe");
    assert.equal(s.fields.motivo.editedByProfessional, true);
    assert.equal(s.fields.motivo.status, "requiere_revision", "la propuesta nueva queda a la vista para revisar");
    assert.ok(s.fields.motivo.reasons.includes("nueva_informacion"));
  });

  it("respuesta tardía después de cerrar la sesión: se descarta", async () => {
    const c = await login("demo-a");
    const id = await stoppedInterview(c);
    const d = deferred<unknown>();
    fake.next = () => d.promise;
    const aborted = fake.aborted;
    await c.json("POST", `/api/interviews/${id}/ai`, {});
    await c.json("POST", "/api/logout", {});
    assert.equal(fake.aborted, aborted + 1, "la solicitud se cancela al cerrar la sesión");
    d.resolve(proposals(fake.calls.at(-1)!));
    await new Promise((r) => setTimeout(r, 150));
    const c2 = await login("demo-a");
    const s = (await c2.json("GET", `/api/interviews/${id}`)).body;
    assert.equal(s.ai?.status, "descartado");
    assert.match(s.ai?.message ?? "", /sesión/);
    assert.ok(Object.values(s.fields).every((f) => f.items.length === 0));
  });

  it("respuesta tardía después del corte diario: se descarta", async () => {
    const c = await login("demo-a");
    const id = await stoppedInterview(c);
    const d = deferred<unknown>();
    fake.next = () => d.promise;
    await c.json("POST", `/api/interviews/${id}/ai`, {});
    clock = nextDailyCutoff(now()) - Date.now() + 1000; // pasa el corte sin otra petición
    try {
      d.resolve(proposals(fake.calls.at(-1)!));
      await new Promise((r) => setTimeout(r, 150));
      const r = await app.service.record("demo-a", id);
      assert.ok(["descartado"].includes(r.ai!.status), r.ai!.status);
      assert.equal(r.ai!.result, null);
    } finally {
      clock = 0;
    }
  });

  it("si la transcripción cambia antes de la respuesta (otra versión), se descarta", async () => {
    const c = await login("demo-a");
    const id = await stoppedInterview(c);
    const d = deferred<unknown>();
    fake.next = () => d.promise;
    await c.json("POST", `/api/interviews/${id}/ai`, {});
    const req = fake.calls.at(-1)!;
    const r = await app.service.record("demo-a", id);
    r.segments.push({ id: `s${r.segments.length + 1}`, speaker: 2, text: "DEMO: me olvidaba, también tomo aspirina.", start: 99, end: 100 });
    d.resolve(proposals(req));
    const s = await waitFor(c, id, (x) => x.ai?.status !== "pendiente");
    assert.equal(s.ai?.status, "descartado");
    assert.match(s.ai?.message ?? "", /transcripción cambió/);
  });

  it("controles: estado, dueño y modo demostración sin Claude", async () => {
    const a = await login("demo-a");
    const b = await login("demo-b");
    const { body } = await a.json("POST", "/api/interviews", {});
    assert.equal((await a.json("POST", `/api/interviews/${body.id}/ai`, {})).status, 409, "sin transcripción");
    const id = await stoppedInterview(a);
    assert.equal((await b.json("POST", `/api/interviews/${id}/ai`, {})).status, 404, "otro profesional");
    // Un servidor sin proveedor (modo demostración por defecto) no expone el llenado.
    const plain = createApp(loadConfig({ DEMO_SPEED: "100", STATIC_DIR: "public" }));
    try {
      assert.equal(plain.service.fillEnabled, false);
    } finally {
      await plain.close();
    }
  });

  it("los registros no contienen texto clínico de la transcripción ni de las propuestas", () => {
    const all = logs.join("\n");
    for (const s of ["mucha sed", "Metformina", "diabética", "DEMO: control de diabetes", "aspirina"])
      assert.ok(!all.includes(s), `registro con contenido clínico: ${s}`);
    assert.ok(all.includes("ai_fill_done"));
    assert.ok(all.includes("ai_fill_discarded"));
  });
});

describe("configuración del llenado con Claude", () => {
  const real = {
    DEMO_MODE: "false",
    DATABASE_URL: "postgres://u:p@db.invalid:5432/x",
    BETTER_AUTH_SECRET: "x".repeat(40),
    BETTER_AUTH_URL: "https://anamnesis.invalid",
    EMAIL_TRANSPORT: "prueba",
  };
  it("requiere activación explícita, modo cuentas y clave en el servidor", () => {
    assert.equal(loadConfig({ ...real, ANTHROPIC_API_KEY: "sk-ficticia" }).claude, undefined, "la clave sola no activa nada");
    assert.throws(() => loadConfig({ CLAUDE_FILL: "true", ANTHROPIC_API_KEY: "sk-ficticia" }), /DEMO_MODE=false/);
    assert.throws(() => loadConfig({ ...real, CLAUDE_FILL: "true" }), /ANTHROPIC_API_KEY/);
    assert.throws(() => loadConfig({ ...real, CLAUDE_FILL: "si" }), /CLAUDE_FILL/);
    const c = loadConfig({ ...real, CLAUDE_FILL: "true", ANTHROPIC_API_KEY: "sk-ficticia" });
    assert.equal(c.claude?.model, "claude-opus-5-5");
    assert.equal(c.claude?.effort, "high");
    assert.throws(() => loadConfig({ ...real, CLAUDE_FILL: "true", ANTHROPIC_API_KEY: "k", CLAUDE_EFFORT: "turbo" }), /CLAUDE_EFFORT/);
    assert.equal(loadConfig({ DEMO_SPEED: "100" }).claude, undefined, "el modo demostración no llama a Claude");
    assert.equal(loadConfig({ ALLOW_TEST_FILL: "true" }).testFill, true);
    assert.equal(loadConfig({ ALLOW_TEST_FILL: "true", NODE_ENV: "production" }).testFill, false, "nunca en producción");
  });
});
