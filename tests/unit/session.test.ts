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
  app = createApp(loadConfig({ DEMO_SPEED: "100", STATIC_DIR: "public", SESSION_CHECK_MS: "200" }), {
    now: () => Date.now() + offset,
  });
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

/** Abre un canal de eventos y espera su cierre, sin hacer ninguna otra petición. */
async function openStream(c: Client, interviewId: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/interviews/${interviewId}/events`, { headers: { Cookie: c.cookie }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  let text = "";
  const ended = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return text;
      text += dec.decode(value);
    }
  })();
  const waitEnd = (ms: number) =>
    Promise.race([ended, new Promise<null>((r) => setTimeout(() => r(null), ms))]).then((v) => {
      if (v === null) ctrl.abort();
      return v;
    });
  return { waitEnd };
}

describe("canales en vivo ligados a su sesión", () => {
  it("el servidor cierra el canal en el corte, sin peticiones posteriores ni temporizador del navegador", async () => {
    const c = await login("demo-a");
    const { body } = await c.json<InterviewSnapshot>("POST", "/api/interviews", {});
    const s = await c.json<SessionInfo>("GET", "/api/session");
    offset = Date.parse(s.body.cutoffAt) - Date.now() - 1500; // 1,5 s antes del corte
    // La sesión estuvo activa hasta ese instante (no se prueba aquí la inactividad).
    await app.store.touchActivity(c.cookie.split("=")[1], Date.now() + offset);
    const stream = await openStream(c, body.id);
    const text = await stream.waitEnd(5000);
    assert.ok(text !== null, "el canal debe cerrarse solo al llegar el corte");
    assert.match(text!, /event: session_ended\ndata: \{"reason":"corte_diario"\}/);
    offset = 0;
    assert.equal((await c.json("GET", "/api/session")).body.error, "sin_sesion", "la sesión quedó revocada");
  });

  it("si la sesión se revoca por otra vía, el servidor cierra su canal", async () => {
    const c = await login("demo-a");
    const { body } = await c.json<InterviewSnapshot>("POST", "/api/interviews", {});
    const stream = await openStream(c, body.id);
    const sid = c.cookie.split("=")[1];
    // Revocación directa (como un cambio de contraseña en otro dispositivo), sin tocar el canal.
    await app.gate.revoke({ sessionId: sid, user: { id: "demo-a", name: "x" }, createdAt: Date.now() });
    const text = await stream.waitEnd(3000);
    assert.ok(text !== null, "el canal debe cerrarse tras la revocación");
    assert.match(text!, /"reason":"revocada"/);
  });

  it("el servidor cierra el canal por inactividad", async () => {
    const c = await login("demo-b");
    await c.json("PATCH", "/api/settings", { idleMinutes: 5 });
    const { body } = await c.json<InterviewSnapshot>("POST", "/api/interviews", {});
    const stream = await openStream(c, body.id);
    offset = 6 * 60_000;
    const text = await stream.waitEnd(3000);
    offset = 0;
    assert.ok(text !== null);
    assert.match(text!, /"reason":"inactividad"/);
  });

  it("cerrar sesión en un dispositivo cierra solo los canales de esa sesión", async () => {
    const phone = await login("demo-a");
    const pc = await login("demo-a");
    const { body } = await phone.json<InterviewSnapshot>("POST", "/api/interviews", {});
    const s1 = await openStream(phone, body.id);
    const s2 = await openStream(pc, body.id);
    await phone.req("POST", "/api/logout", {});
    assert.ok((await s1.waitEnd(2000)) !== null, "el canal del dispositivo que cerró sesión se cierra");
    assert.equal(await s2.waitEnd(1000), null, "el otro dispositivo sigue conectado");
    assert.equal((await pc.json("GET", "/api/session")).status, 200);
  });
});

describe("escucha ligada a la sesión que la inició (dos dispositivos, misma cuenta)", () => {
  // Servidor aparte con la entrevista ficticia lenta: la escucha sigue activa durante la prueba.
  let slow: App;
  let slowBase: string;
  let clock = 0;

  before(async () => {
    slow = createApp(
      loadConfig({ DEMO_SPEED: "0.25", STATIC_DIR: "public", SESSION_CHECK_MS: "200", DISCONNECT_PAUSE_MS: "60000" }),
      { now: () => Date.now() + clock },
    );
    await new Promise<void>((r) => slow.server.listen(0, "127.0.0.1", r));
    slowBase = `http://127.0.0.1:${(slow.server.address() as AddressInfo).port}`;
  });
  after(() => slow.close());
  beforeEach(() => {
    clock = 0;
  });

  class Device {
    cookie = "";
    async json<T>(method: string, path: string, body?: unknown) {
      const res = await fetch(slowBase + path, {
        method,
        headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get("set-cookie");
      if (sc) this.cookie = /Max-Age=0/.test(sc) ? "" : sc.split(";")[0];
      return { status: res.status, body: (await res.json()) as T & { error?: string } };
    }
    get sid() {
      return this.cookie.split("=")[1];
    }
    async stream(interviewId: string) {
      const ctrl = new AbortController();
      const res = await fetch(`${slowBase}/api/interviews/${interviewId}/events`, { headers: { Cookie: this.cookie }, signal: ctrl.signal });
      assert.equal(res.status, 200);
      const reader = res.body!.getReader();
      let text = "";
      let closed = false;
      const done = (async () => {
        const d = new TextDecoder();
        for (;;) {
          const r = await reader.read().catch(() => ({ done: true, value: undefined }));
          if (r.done) {
            closed = true;
            return text;
          }
          text += d.decode(r.value);
        }
      })();
      return {
        isClosed: () => closed,
        text: () => text,
        waitEnd: (ms: number) => Promise.race([done, new Promise<null>((r) => setTimeout(() => r(null), ms))]),
        close: () => ctrl.abort(),
      };
    }
  }

  async function device() {
    const d = new Device();
    await d.json("POST", "/api/demo/session", { perfil: "demo-a" });
    return d;
  }

  /** El PC inicia la escucha y la mira; el teléfono observa la misma entrevista. */
  async function setup() {
    const pc = await device();
    const phone = await device();
    await pc.json("PATCH", "/api/settings", { idleMinutes: 5 });
    const { body } = await pc.json<InterviewSnapshot>("POST", "/api/interviews", {});
    await pc.json("POST", `/api/interviews/${body.id}/consent`, { givenBy: "paciente" });
    const started = await pc.json<InterviewSnapshot>("POST", `/api/interviews/${body.id}/command`, { command: "iniciar" });
    assert.equal(started.body.status, "escuchando");
    const pcStream = await pc.stream(body.id);
    const phoneStream = await phone.stream(body.id);
    return { pc, phone, id: body.id, pcStream, phoneStream };
  }

  async function status(d: Device, id: string) {
    return (await d.json<InterviewSnapshot>("GET", `/api/interviews/${id}`)).body;
  }

  it("el teléfono inactivo caduca mientras el PC sigue escuchando", async () => {
    const { pc, phone, id, pcStream, phoneStream } = await setup();
    clock = 6 * 60_000; // 6 minutos sin actividad en ningún dispositivo
    const ended = await phoneStream.waitEnd(3000);
    assert.ok(ended !== null, "el canal del teléfono inactivo debe cerrarse");
    assert.match(ended!, /"reason":"inactividad"/);
    assert.equal((await phone.json("GET", "/api/session")).body.error, "sin_sesion", "la sesión del teléfono caducó");
    // El PC, que escucha, no caduca ni deja de escuchar.
    assert.equal(pcStream.isClosed(), false);
    const pcSession = await pc.json<SessionInfo>("GET", "/api/session");
    assert.equal(pcSession.status, 200);
    assert.equal((await status(pc, id)).status, "escuchando");
    pcStream.close();
    await pc.json("POST", `/api/interviews/${id}/command`, { command: "detener" });
  });

  it("cerrar la sesión observadora (teléfono) conserva la escucha del PC", async () => {
    const { pc, phone, id, pcStream, phoneStream } = await setup();
    const out = await phone.json("POST", "/api/logout", {});
    assert.equal(out.status, 200);
    assert.ok((await phoneStream.waitEnd(2000)) !== null, "el canal del teléfono se cierra");
    await new Promise((r) => setTimeout(r, 500)); // al menos dos revisiones del servidor
    assert.equal(pcStream.isClosed(), false, "el canal del PC sigue abierto");
    const s = await status(pc, id);
    assert.equal(s.status, "escuchando", "la escucha del PC continúa");
    pcStream.close();
    await pc.json("POST", `/api/interviews/${id}/command`, { command: "detener" });
  });

  it("revocar la sesión que inició la escucha sí la pausa (aunque no tenga pantalla conectada)", async () => {
    const { pc, phone, id, pcStream, phoneStream } = await setup();
    pcStream.close(); // el PC ni siquiera tiene el canal abierto
    await new Promise((r) => setTimeout(r, 100));
    // Revocación por otra vía (p. ej., cambio de contraseña), sin peticiones del PC.
    await slow.gate.revoke({ sessionId: pc.sid, user: { id: "demo-a", name: "x" }, createdAt: Date.now() });
    let s: InterviewSnapshot | undefined;
    for (let i = 0; i < 20; i++) {
      s = await status(phone, id);
      if (s.status !== "escuchando") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(s!.status, "pausada");
    assert.equal(s!.pauseReason, "revocada");
    assert.equal(phoneStream.isClosed(), false, "el teléfono observador sigue conectado");
    phoneStream.close();
  });

  it("la sesión que reanuda pasa a ser la dueña de la escucha", async () => {
    const { pc, phone, id, pcStream, phoneStream } = await setup();
    await pc.json("POST", `/api/interviews/${id}/command`, { command: "pausar" });
    await phone.json("POST", `/api/interviews/${id}/command`, { command: "reanudar" });
    // Ahora cerrar la sesión del PC no pausa (escucha del teléfono)…
    await pc.json("POST", "/api/logout", {});
    await pcStream.waitEnd(2000);
    assert.equal((await status(phone, id)).status, "escuchando");
    // …y cerrar la del teléfono sí.
    const other = await device();
    await phone.json("POST", "/api/logout", {});
    await phoneStream.waitEnd(2000);
    const s = await status(other, id);
    assert.equal(s.status, "pausada");
    assert.equal(s.pauseReason, "manual");
  });

  it("corte sin pantalla: el servidor pausa la escucha y revoca la sesión aunque no haya ningún canal abierto", async () => {
    const pc = await device();
    const { body } = await pc.json<InterviewSnapshot>("POST", "/api/interviews", {});
    await pc.json("POST", `/api/interviews/${body.id}/consent`, { givenBy: "paciente" });
    const started = await pc.json<InterviewSnapshot>("POST", `/api/interviews/${body.id}/command`, { command: "iniciar" });
    assert.equal(started.body.status, "escuchando");
    const { body: info } = await pc.json<SessionInfo>("GET", "/api/session");
    // Sin canal abierto y sin más peticiones del PC: el reloj del servidor pasa las 23:59.
    clock = Date.parse(info.cutoffAt) - Date.now() + 500;
    let snap: InterviewSnapshot | undefined;
    for (let i = 0; i < 25; i++) {
      snap = await slow.service.read("demo-a", body.id); // lectura interna, no es una petición del PC
      if (snap.status !== "escuchando") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(snap!.status, "pausada", "la escucha debe pausarse en el corte");
    assert.equal(snap!.pauseReason, "corte_diario");
    assert.equal(await slow.gate.isActive(pc.sid), false, "la sesión que escuchaba queda revocada");
    assert.equal((await pc.json("GET", "/api/session")).body.error, "sin_sesion");
  });

  it("la sesión que escucha no se bloquea por inactividad", async () => {
    const { pc, id, pcStream, phoneStream } = await setup();
    phoneStream.close();
    clock = 10 * 60_000;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(pcStream.isClosed(), false);
    const r = await pc.json<InterviewSnapshot>("GET", `/api/interviews/${id}`);
    assert.equal(r.status, 200, String(r.body.error));
    assert.equal(r.body.status, "escuchando");
    pcStream.close();
    await pc.json("POST", `/api/interviews/${id}/command`, { command: "detener" });
  });
});
