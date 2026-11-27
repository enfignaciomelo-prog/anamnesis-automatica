/**
 * IndexedDB para los borradores cifrados sin conexión. Única base de datos que
 * la limpieza de sesión conserva (hasta el corte diario); su contenido está
 * cifrado (ver vault.ts).
 */
import type { Backend, RecordRow, SpaceMeta } from "./vault";

export const OFFLINE_DB = "aa-offline";
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(OFFLINE_DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("spaces")) db.createObjectStore("spaces", { keyPath: "spaceId" });
      if (!db.objectStoreNames.contains("records")) {
        const s = db.createObjectStore("records", { keyPath: ["spaceId", "id"] });
        s.createIndex("bySpace", "spaceId");
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("La base local está bloqueada por otra pestaña."));
  });
}

function done(t: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error ?? new Error("No se pudo guardar en este dispositivo."));
  });
}

function req<T>(r: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function withStore<T>(names: string[], mode: IDBTransactionMode, f: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await open();
  try {
    const t = db.transaction(names, mode);
    const out = await f(t);
    await done(t);
    return out;
  } finally {
    db.close();
  }
}

/** ¿Existe la base? Evita crearla solo por consultarla. */
async function exists() {
  if (!indexedDB.databases) return true;
  return (await indexedDB.databases()).some((d) => d.name === OFFLINE_DB);
}

export class IdbBackend implements Backend {
  async listSpaces(): Promise<SpaceMeta[]> {
    if (!(await exists())) return [];
    return withStore(["spaces"], "readonly", (t) => req(t.objectStore("spaces").getAll() as IDBRequest<SpaceMeta[]>));
  }
  async putSpace(s: SpaceMeta) {
    await withStore(["spaces"], "readwrite", (t) => void t.objectStore("spaces").put(s));
  }
  async deleteSpace(spaceId: string) {
    await withStore(["spaces", "records"], "readwrite", async (t) => {
      t.objectStore("spaces").delete(spaceId);
      const recs = t.objectStore("records");
      const keys = await req(recs.index("bySpace").getAllKeys(spaceId));
      for (const k of keys) recs.delete(k);
    });
    // Sin espacios: se elimina la base completa.
    if ((await this.listSpaces()).length === 0) await deleteOfflineDb();
  }
  async listRecords(spaceId: string): Promise<RecordRow[]> {
    return withStore(["records"], "readonly", (t) =>
      req(t.objectStore("records").index("bySpace").getAll(spaceId) as IDBRequest<RecordRow[]>),
    );
  }
  async getRecord(spaceId: string, id: string) {
    return withStore(["records"], "readonly", (t) =>
      req(t.objectStore("records").get([spaceId, id]) as IDBRequest<RecordRow | undefined>),
    );
  }
  async putRecord(r: RecordRow) {
    await withStore(["records"], "readwrite", (t) => void t.objectStore("records").put(r));
  }
  async deleteRecord(spaceId: string, id: string) {
    await withStore(["records"], "readwrite", (t) => void t.objectStore("records").delete([spaceId, id]));
  }
}

export function deleteOfflineDb() {
  return new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(OFFLINE_DB);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}
