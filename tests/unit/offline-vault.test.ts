/**
 * Borradores cifrados del dispositivo (web/offline/vault.ts) con Web Crypto de
 * Node y un almacenamiento en memoria. IndexedDB real se prueba en el E2E (Chromium).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { OfflinePackage, OfflineSyncRequest } from "../../shared/offline";
import { GENERIC_TEMPLATE } from "../../shared/template-generic";
import { WrongPassphraseError } from "../../web/offline/crypto";
import {
  CLOCK_BACK_TOLERANCE_MS,
  draftStatusLabel,
  MemoryBackend,
  OfflineVault,
  purgeExpired,
  type SendResult,
  spaceFor,
  StaleDraftError,
} from "../../web/offline/vault";

const ITER = 1000; // rápido en pruebas; la app usa 600.000
const PASS = "frase de prueba larga";

function pkg(id = "demo-a", cutoffInMs = 3_600_000): OfflinePackage {
  return {
    professional: { id, name: `Profesional ${id}` },
    templates: [GENERIC_TEMPLATE],
    cutoffAt: new Date(Date.now() + cutoffInMs).toISOString(),
    serverTime: new Date().toISOString(),
  };
}

const realFetch = globalThis.fetch;
const realNow = Date.now;
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

function allBytes(b: MemoryBackend) {
  return Buffer.concat([...b.records.values()].map((r) => Buffer.from(r.data))).toString("latin1") +
    JSON.stringify([...b.spaces.values()]);
}

describe("borradores cifrados en el dispositivo", () => {
  it("el contenido queda cifrado: ni textos, ni nombres, ni plantillas en claro", async () => {
    const b = new MemoryBackend();
    const v = await OfflineVault.prepare(b, pkg(), PASS, 15, ITER);
    const d = await v.newDraft("generica");
    await v.saveFields(d.id, { motivo: "DEMO-TEXTO-SECRETO cefalea" }, d.revision);
    const raw = allBytes(b);
    for (const s of ["DEMO-TEXTO-SECRETO", "cefalea", "Profesional demo-a", "demo-a", "Motivo de consulta", "sin conexión"])
      assert.ok(!raw.includes(s), `aparece en claro: ${s}`);
    assert.ok(!raw.includes(PASS), "la frase nunca se guarda");
  });

  it("frase incorrecta no abre; la correcta sí, y desbloquear no contacta al servidor ni prolonga la sesión", async () => {
    const b = new MemoryBackend();
    const v = await OfflineVault.prepare(b, pkg(), PASS, 15, ITER);
    const d = await v.newDraft("generica");
    await v.saveFields(d.id, { motivo: "DEMO" }, d.revision);
    const space = (await spaceFor(b, "demo-a"))!;
    await assert.rejects(OfflineVault.unlock(b, space, "otra frase cualquiera"), WrongPassphraseError);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("sin red");
    }) as typeof fetch;
    const v2 = await OfflineVault.unlock(b, space, PASS);
    assert.equal((await v2.drafts())[0].fields.motivo, "DEMO");
    assert.equal(calls, 0);
    v2.lock();
    await assert.rejects(v2.drafts(), /bloqueados/);
  });

  it("espacios separados por profesional: B no encuentra ni abre el de A", async () => {
    const b = new MemoryBackend();
    await OfflineVault.prepare(b, pkg("demo-a"), PASS, 15, ITER);
    assert.equal(await spaceFor(b, "demo-b"), undefined);
    const vb = await OfflineVault.prepare(b, pkg("demo-b"), "frase de B distinta", 15, ITER);
    assert.equal((await vb.drafts()).length, 0);
    const spaceA = (await spaceFor(b, "demo-a"))!;
    await assert.rejects(OfflineVault.unlock(b, spaceA, "frase de B distinta"), WrongPassphraseError);
    await assert.rejects(OfflineVault.prepare(b, pkg("demo-a"), PASS, 15, ITER), /ya está preparado/);
  });

  it("corte diario: se eliminan los borradores aunque no se hayan sincronizado", async () => {
    const b = new MemoryBackend();
    const v = await OfflineVault.prepare(b, pkg("demo-a", 60_000), PASS, 15, ITER);
    const d = await v.newDraft("generica");
    await v.saveFields(d.id, { motivo: "DEMO sin sincronizar" }, d.revision);
    assert.equal(draftStatusLabel((await v.drafts())[0]), "Pendiente de sincronizar");
    assert.equal(await purgeExpired(b, Date.now() + 59_000), 0);
    assert.equal(await purgeExpired(b, Date.now() + 61_000), 1);
    assert.equal(b.spaces.size, 0);
    assert.equal(b.records.size, 0);
  });

  it("un reloj que retrocede también elimina el espacio (no se puede esquivar el corte)", async () => {
    const b = new MemoryBackend();
    await OfflineVault.prepare(b, pkg(), PASS, 15, ITER);
    assert.equal(await purgeExpired(b, Date.now() - CLOCK_BACK_TOLERANCE_MS - 60_000), 1);
  });

  it("abrir un espacio vencido lo elimina en vez de mostrarlo", async () => {
    const b = new MemoryBackend();
    await OfflineVault.prepare(b, pkg("demo-a", 1000), PASS, 15, ITER);
    const space = [...b.spaces.values()][0];
    const t0 = realNow();
    Date.now = () => t0 + 5000;
    await assert.rejects(OfflineVault.unlock(b, space, PASS), /vencieron/);
    assert.equal(b.spaces.size, 0);
  });

  it("dos pestañas: un guardado sobre una revisión vieja se rechaza en vez de pisar", async () => {
    const b = new MemoryBackend();
    const v = await OfflineVault.prepare(b, pkg(), PASS, 15, ITER);
    const d = await v.newDraft("generica");
    const other = await OfflineVault.unlock(b, (await spaceFor(b, "demo-a"))!, PASS);
    await other.saveFields(d.id, { motivo: "DEMO pestaña 2" }, d.revision);
    await assert.rejects(v.saveFields(d.id, { motivo: "DEMO pestaña 1" }, d.revision), StaleDraftError);
    assert.equal((await v.draft(d.id))!.fields.motivo, "DEMO pestaña 2");
  });
  it("dos guardados simultáneos sobre la misma revisión tienen un solo ganador", async () => {
    const b = new MemoryBackend();
    const v = await OfflineVault.prepare(b, pkg(), PASS, 15, ITER);
    const d = await v.newDraft("generica");
    const other = await OfflineVault.unlock(b, (await spaceFor(b, "demo-a"))!, PASS);
    const results = await Promise.allSettled([
      v.saveFields(d.id, { motivo: "DEMO pestaña 1" }, d.revision),
      other.saveFields(d.id, { motivo: "DEMO pestaña 2" }, d.revision),
    ]);
    const accepted = results.find((r) => r.status === "fulfilled");
    const rejected = results.find((r) => r.status === "rejected");
    assert.ok(accepted);
    assert.ok(rejected?.reason instanceof StaleDraftError);
    assert.equal((await v.draft(d.id))?.fields.motivo, accepted.value.fields.motivo);
  });

  it("una pestaña con la clave abierta no recrea un espacio ya eliminado", async () => {
    const b = new MemoryBackend();
    const v = await OfflineVault.prepare(b, pkg(), PASS, 15, ITER);
    const other = await OfflineVault.unlock(b, (await spaceFor(b, "demo-a"))!, PASS);
    await v.destroy();
    await assert.rejects(other.newDraft("generica"), /venció o se eliminó/);
    assert.equal(b.spaces.size, 0);
    assert.equal(b.records.size, 0);
  });

});

describe("sincronización desde el dispositivo", () => {
  const okSend = (calls: OfflineSyncRequest[]) => async (r: OfflineSyncRequest): Promise<SendResult> => {
    calls.push(r);
    return { ok: true, status: 200, body: { status: "sincronizado", interviewId: "iv-1", revision: r.revision, duplicate: false } };
  };

  it("al sincronizar se elimina el contenido local y queda «Sincronizado con tu cuenta»", async () => {
    const b = new MemoryBackend();
    const v = await OfflineVault.prepare(b, pkg(), PASS, 15, ITER);
    const d = await v.newDraft("generica");
    await v.saveFields(d.id, { motivo: "DEMO-CONTENIDO" }, d.revision);
    const calls: OfflineSyncRequest[] = [];
    const s = await v.syncAll("demo-a", okSend(calls));
    assert.deepEqual(s, { synced: 1, failed: 0, offline: false });
    assert.equal(calls[0].clientId, d.id);
    assert.equal(calls[0].revision, 2);
    const after = (await v.drafts())[0];
    assert.equal(draftStatusLabel(after), "Sincronizado con tu cuenta");
    assert.deepEqual(after.fields, {});
    await v.syncAll("demo-a", okSend(calls));
    assert.equal(calls.length, 1, "lo sincronizado no se reenvía");
  });

  it("sin conexión queda «Pendiente de sincronizar» y se reintenta con el mismo identificador", async () => {
    const b = new MemoryBackend();
    const v = await OfflineVault.prepare(b, pkg(), PASS, 15, ITER);
    const d = await v.newDraft("generica");
    const s = await v.syncAll("demo-a", async () => {
      throw new TypeError("Failed to fetch");
    });
    assert.equal(s.offline, true);
    assert.equal(draftStatusLabel((await v.drafts())[0]), "Pendiente de sincronizar");
    const calls: OfflineSyncRequest[] = [];
    await v.syncAll("demo-a", okSend(calls));
    assert.equal(calls[0].clientId, d.id);
  });

  it("conflicto: conserva la copia local con «Error de sincronización»; guardar como nueva usa otro identificador", async () => {
    const b = new MemoryBackend();
    const v = await OfflineVault.prepare(b, pkg(), PASS, 15, ITER);
    const d = await v.newDraft("generica");
    await v.saveFields(d.id, { motivo: "DEMO local" }, d.revision);
    await v.syncAll("demo-a", async () => ({
      ok: false,
      status: 409,
      body: { error: "conflicto_sincronizacion", reason: "modificada_en_servidor", interviewId: "iv-9", message: "cambió" },
    }));
    const c = (await v.drafts())[0];
    assert.equal(draftStatusLabel(c), "Error de sincronización");
    assert.equal(c.fields.motivo, "DEMO local");
    assert.equal(c.conflict?.reason, "modificada_en_servidor");
    // Sin decisión del profesional no se vuelve a enviar.
    const calls: OfflineSyncRequest[] = [];
    await v.syncAll("demo-a", okSend(calls));
    assert.equal(calls.length, 0);
    const copy = await v.asNewCopy(c.id);
    assert.notEqual(copy.id, d.id);
    await v.syncAll("demo-a", okSend(calls));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].clientId, copy.id);
    assert.equal(calls[0].revision, 1);
  });

  it("si se editó mientras se enviaba, la revisión nueva queda pendiente", async () => {
    const b = new MemoryBackend();
    const v = await OfflineVault.prepare(b, pkg(), PASS, 15, ITER);
    const d = await v.newDraft("generica");
    await v.syncAll("demo-a", async (r) => {
      await v.saveFields(d.id, { motivo: "DEMO editado durante el envío" }, 1);
      return { ok: true, status: 200, body: { status: "sincronizado", interviewId: "iv-1", revision: r.revision, duplicate: false } };
    });
    const cur = (await v.drafts())[0];
    assert.equal(draftStatusLabel(cur), "Pendiente de sincronizar");
    assert.equal(cur.fields.motivo, "DEMO editado durante el envío");
  });

  it("no sincroniza con la sesión de otro profesional", async () => {
    const b = new MemoryBackend();
    const v = await OfflineVault.prepare(b, pkg("demo-a"), PASS, 15, ITER);
    await v.newDraft("generica");
    await assert.rejects(v.syncAll("demo-b", okSend([])), /otro profesional/);
  });
});
