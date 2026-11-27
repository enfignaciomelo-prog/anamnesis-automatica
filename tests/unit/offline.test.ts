/**
 * Sincronización de borradores escritos sin conexión: idempotencia, conflictos
 * sin sobrescritura silenciosa, plantilla del servidor y separación entre profesionales.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { OfflinePackage, OfflineSyncResponse } from "../../shared/offline";
import type { InterviewSnapshot, InterviewSummary } from "../../shared/types";
import { type App, createApp } from "../../server/app";
import { loadConfig } from "../../server/config";
import { setLogSink } from "../../server/log";

const logs: string[] = [];
let app: App;
let base: string;

before(async () => {
  setLogSink((l) => logs.push(l));
  app = createApp(loadConfig({ STATIC_DIR: "public" }));
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => app.close());

class Client {
  cookie = "";
  async json<T>(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    return { status: res.status, body: (await res.json()) as T & { error?: string; reason?: string; interviewId?: string } };
  }
}

async function login(perfil: "demo-a" | "demo-b") {
  const c = new Client();
  const r = await c.json("POST", "/api/demo/session", { perfil });
  assert.equal(r.status, 200);
  return c;
}

function draft(over: Partial<Record<string, unknown>> = {}) {
  return {
    clientId: randomUUID(),
    revision: 1,
    templateId: "generica",
    templateVersion: 1,
    createdAt: new Date().toISOString(),
    fields: { motivo: "DEMO: control de presión arterial", alergias: "" },
    ...over,
  };
}

describe("modo sin conexión: sincronización", () => {
  it("el paquete trae las plantillas del profesional y el corte de su sesión", async () => {
    const a = await login("demo-a");
    const { status, body } = await a.json<OfflinePackage>("GET", "/api/offline/package");
    assert.equal(status, 200);
    assert.ok(body.templates.some((t) => t.id === "generica"));
    assert.ok(Date.parse(body.cutoffAt) > Date.now());
    assert.equal(body.professional.id, "demo-a");
  });

  it("crea una anamnesis manual: lo escrito queda como edición del profesional y lo vacío «No referido»", async () => {
    const a = await login("demo-a");
    const d = draft();
    const { status, body } = await a.json<OfflineSyncResponse>("POST", "/api/offline/sync", d);
    assert.equal(status, 200);
    assert.equal(body.duplicate, false);
    const snap = (await a.json<InterviewSnapshot>("GET", `/api/interviews/${body.interviewId}`)).body;
    assert.equal(snap.status, "detenida");
    assert.equal(snap.consent, null);
    assert.equal(snap.segments.length, 0);
    assert.equal(snap.fields.motivo.professionalValue, "DEMO: control de presión arterial");
    assert.equal(snap.fields.motivo.editedByProfessional, true);
    assert.equal(snap.fields.alergias.status, "no_referido");
    assert.match(snap.title, /sin conexión/);
  });

  it("es idempotente: reenviar la misma revisión (respuesta perdida, dos pestañas) no crea copias", async () => {
    const a = await login("demo-a");
    const d = draft();
    const before = (await a.json<InterviewSummary[]>("GET", "/api/interviews")).body.length;
    const [r1, r2] = await Promise.all([a.json<OfflineSyncResponse>("POST", "/api/offline/sync", d), a.json<OfflineSyncResponse>("POST", "/api/offline/sync", d)]);
    const r3 = await a.json<OfflineSyncResponse>("POST", "/api/offline/sync", d);
    assert.equal(r1.body.interviewId, r2.body.interviewId);
    assert.equal(r1.body.interviewId, r3.body.interviewId);
    assert.equal([r1, r2, r3].filter((r) => r.body.duplicate).length, 2);
    const afterN = (await a.json<InterviewSummary[]>("GET", "/api/interviews")).body.length;
    assert.equal(afterN, before + 1);
  });

  it("rechaza el mismo número de revisión con contenido distinto", async () => {
    const a = await login("demo-a");
    const d = draft();
    assert.equal((await a.json("POST", "/api/offline/sync", d)).status, 200);
    const other = await a.json("POST", "/api/offline/sync", { ...d, fields: { motivo: "DEMO distinto" } });
    assert.equal(other.status, 409);
    assert.equal(other.body.reason, "revision_distinta");
  });

  it("una revisión posterior actualiza la misma anamnesis si nadie la cambió en el servidor", async () => {
    const a = await login("demo-a");
    const d = draft();
    const r1 = (await a.json<OfflineSyncResponse>("POST", "/api/offline/sync", d)).body;
    const r2 = await a.json<OfflineSyncResponse>("POST", "/api/offline/sync", {
      ...d,
      revision: 2,
      fields: { motivo: "DEMO: control y cefalea" },
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.interviewId, r1.interviewId);
    const snap = (await a.json<InterviewSnapshot>("GET", `/api/interviews/${r1.interviewId}`)).body;
    assert.equal(snap.fields.motivo.professionalValue, "DEMO: control y cefalea");
  });

  it("conflicto: si se editó en el servidor, no sobrescribe y responde 409", async () => {
    const a = await login("demo-a");
    const d = draft();
    const { interviewId } = (await a.json<OfflineSyncResponse>("POST", "/api/offline/sync", d)).body;
    await a.json("POST", `/api/interviews/${interviewId}/fields/motivo/confirm`, { value: "DEMO: editado en el PC" });
    const r = await a.json("POST", "/api/offline/sync", { ...d, revision: 2, fields: { motivo: "DEMO: versión del teléfono" } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "conflicto_sincronizacion");
    assert.equal(r.body.reason, "modificada_en_servidor");
    assert.equal(r.body.interviewId, interviewId);
    const snap = (await a.json<InterviewSnapshot>("GET", `/api/interviews/${interviewId}`)).body;
    assert.equal(snap.fields.motivo.professionalValue, "DEMO: editado en el PC");
  });

  it("conflicto: una anamnesis eliminada en el servidor no se vuelve a crear en silencio", async () => {
    const a = await login("demo-a");
    const d = draft();
    const { interviewId } = (await a.json<OfflineSyncResponse>("POST", "/api/offline/sync", d)).body;
    await a.json("DELETE", `/api/interviews/${interviewId}`);
    const before = (await a.json<InterviewSummary[]>("GET", "/api/interviews")).body.length;
    const r = await a.json("POST", "/api/offline/sync", { ...d, revision: 2 });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, "eliminada_en_servidor");
    assert.equal((await a.json<InterviewSummary[]>("GET", "/api/interviews")).body.length, before);
  });

  it("conflicto: una anamnesis finalizada no se modifica", async () => {
    const a = await login("demo-a");
    const d = draft();
    const { interviewId } = (await a.json<OfflineSyncResponse>("POST", "/api/offline/sync", d)).body;
    const fin = await a.json("POST", `/api/interviews/${interviewId}/finalize`, { attested: true });
    assert.equal(fin.status, 200);
    const r = await a.json("POST", "/api/offline/sync", { ...d, revision: 2 });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, "finalizada");
  });

  it("otro profesional no puede usar el mismo identificador para leer ni escribir", async () => {
    const a = await login("demo-a");
    const b = await login("demo-b");
    const d = draft();
    const ra = (await a.json<OfflineSyncResponse>("POST", "/api/offline/sync", d)).body;
    const rb = await b.json<OfflineSyncResponse>("POST", "/api/offline/sync", { ...d, revision: 5, fields: { motivo: "DEMO: B" } });
    assert.equal(rb.status, 200);
    assert.notEqual(rb.body.interviewId, ra.interviewId, "B obtiene su propia anamnesis, nunca la de A");
    assert.equal((await b.json("GET", `/api/interviews/${ra.interviewId}`)).status, 404);
    const snapA = (await a.json<InterviewSnapshot>("GET", `/api/interviews/${ra.interviewId}`)).body;
    assert.equal(snapA.fields.motivo.professionalValue, "DEMO: control de presión arterial");
  });

  it("la plantilla la decide el servidor: versión inexistente, plantilla ajena o campo desconocido se rechazan", async () => {
    const a = await login("demo-a");
    const b = await login("demo-b");
    assert.equal((await a.json("POST", "/api/offline/sync", draft({ templateVersion: 99 }))).status, 404);
    const own = await b.json<{ id: string; version: number }>("POST", "/api/templates", { fromId: "generica" });
    assert.equal(own.status, 201);
    assert.equal(
      (await a.json("POST", "/api/offline/sync", draft({ templateId: own.body.id, templateVersion: own.body.version }))).status,
      404,
    );
    const bad = await a.json("POST", "/api/offline/sync", draft({ fields: { inventado: "x" } }));
    assert.equal(bad.status, 400);
    assert.equal((await a.json("POST", "/api/offline/sync", draft({ clientId: "no-uuid" }))).status, 400);
  });

  it("exige sesión y no registra contenido clínico", async () => {
    const anon = new Client();
    assert.equal((await anon.json("POST", "/api/offline/sync", draft())).status, 401);
    assert.equal((await anon.json("GET", "/api/offline/package")).status, 401);
    const a = await login("demo-a");
    await a.json("POST", "/api/offline/sync", draft({ fields: { motivo: "DEMO-SECRETO-OFFLINE" } }));
    assert.ok(!logs.join("\n").includes("DEMO-SECRETO-OFFLINE"));
  });
});
