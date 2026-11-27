import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import type { InterviewSnapshot } from "../../shared/types";
import { createApp } from "../../server/app";
import { loadConfig } from "../../server/config";
import { mockDeepgram } from "../mockDeepgram";

it("Deepgram exige activación explícita, cuentas y una clave", () => {
  assert.equal(loadConfig({ DEEPGRAM_API_KEY: "ficticia" }).deepgram, undefined);
  assert.throws(() => loadConfig({ TRANSCRIPTION_MODE: "deepgram", DEEPGRAM_API_KEY: "ficticia" }), /DEMO_MODE=false/);
});

it("la captura exige consentimiento y su sesión, deduplica y conserva el último audio al pausar", async (t) => {
  const provider = await mockDeepgram();
  const app = createApp({ ...loadConfig({}), deepgram: { key: "ficticia" } }, { connectDeepgram: provider.connect });
  t.after(async () => { await app.close(); await provider.close(); });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const req = (cookie: string, path: string, body?: object | Uint8Array) => {
    const audio = body instanceof Uint8Array;
    return fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { ...(cookie && { Cookie: cookie }), ...(body && { "Content-Type": audio ? "application/octet-stream" : "application/json" }) },
      body: body ? (audio ? new Uint8Array(body) : JSON.stringify(body)) : undefined,
    });
  };
  const login = async () => {
    const res = await req("", "/api/demo/session", { perfil: "demo-a" });
    assert.equal(res.status, 200);
    return res.headers.getSetCookie()[0].split(";")[0];
  };
  const cookie = await login();
  const observer = await login();
  const rec = await (await req(cookie, "/api/interviews", {})).json() as InterviewSnapshot;
  const path = `/api/interviews/${rec.id}`;
  const snapshot = async () => await (await req(cookie, path)).json() as InterviewSnapshot;
  const first = randomUUID();
  const command = (action: string, captureId = first) => req(cookie, path + "/command", { command: action, captureId, sampleRate: 48000 });
  const audio = (session: string, capture: string, seq: number) =>
    req(session, `${path}/audio?captura=${capture}&secuencia=${seq}`, new Uint8Array(960));

  assert.equal((await command("iniciar")).status, 403);
  assert.equal(provider.requests.length, 0);
  assert.equal((await req(cookie, path + "/consent", { givenBy: "paciente" })).status, 200);
  assert.equal((await command("iniciar")).status, 200);
  assert.equal((await audio(observer, first, 0)).status, 409);
  assert.equal((await req(cookie, `${path}/audio?captura=${first}&secuencia=0`, new Uint8Array(65538))).status, 413);
  assert.equal((await audio(cookie, first, 0)).status, 200);
  assert.equal((await audio(cookie, first, 0)).status, 200);
  assert.equal((await command("pausar")).status, 200);
  const paused = await snapshot();
  assert.equal(paused.status, "pausada");
  assert.deepEqual(paused.segments.map((s) => s.text), ["Me tinca.", "Ya.", "Me duele la guata."]);
  assert.equal(paused.fields.motivo.status, "no_referido");
  assert.equal(provider.counts[0], 1);
  assert.equal(provider.requests[0].searchParams.get("language"), "es-419");
  assert.equal(provider.requests[0].searchParams.get("mip_opt_out"), "true");

  const second = randomUUID();
  assert.equal((await command("reanudar", second)).status, 200);
  assert.equal((await audio(cookie, first, 1)).status, 409);
  assert.equal((await req(cookie, path + "/command", {
    command: "pausar", reason: "segundo_plano", captureId: first,
  })).status, 409);
  assert.equal((await audio(cookie, second, 0)).status, 200);
  assert.equal((await req(cookie, path + "/command", { command: "detener", reason: "audio_incompleto" })).status, 200);
  const stopped = await snapshot();
  assert.equal(stopped.status, "detenida");
  assert.equal(stopped.pauseReason, "audio_incompleto");
  assert.ok(stopped.segments[3].start >= paused.segments[2].end);
  assert.notEqual(stopped.segments[3].speaker, paused.segments[0].speaker);

  const another = await (await req(cookie, "/api/interviews", {})).json() as InterviewSnapshot;
  const next = `/api/interviews/${another.id}`;
  assert.equal((await req(cookie, next + "/consent", { givenBy: "paciente" })).status, 200);
  assert.equal((await req(cookie, next + "/command", { command: "iniciar", captureId: first, sampleRate: 48000 })).status, 200);
  assert.equal((await req(cookie, next + `/audio?captura=${first}&secuencia=0`, new Uint8Array(960))).status, 200);
  provider.connections[2].terminate();
  const waitForPause = async (session: string) => {
    for (let i = 0; i < 30; i++) {
      const s = await (await req(session, next)).json() as InterviewSnapshot;
      if (s.status === "pausada") return s;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("La captura debe quedar pausada.");
  };
  assert.equal((await waitForPause(cookie)).pauseReason, "transcripcion");
  const third = randomUUID();
  assert.equal((await req(cookie, next + "/command", { command: "reanudar", captureId: third, sampleRate: 48000 })).status, 200);
  const lastAudio = next + `/audio?captura=${third}&secuencia=0`;
  assert.equal((await req(cookie, lastAudio, new Uint8Array(960))).status, 200);
  assert.equal((await req(cookie, "/api/logout", {})).status, 200);
  assert.equal((await waitForPause(observer)).pauseReason, "manual");
  assert.equal((await req(cookie, lastAudio, new Uint8Array(960))).status, 401);
});
