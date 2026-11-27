/**
 * IndexedDB para los borradores cifrados sin conexión. Única base de datos que
 * la limpieza de sesión conserva (hasta el corte diario); su contenido está
 * cifrado (ver vault.ts).
 */
import { isExpired, sameRecord, type Backend, type RecordRow, type SpaceMeta } from "./vault";

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
    const completion = done(t);
    const [out] = await Promise.all([f(t), completion]);
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
  async createSpace(s: SpaceMeta, profile: RecordRow) {
    return withStore(["spaces", "records"], "readwrite", async (t) => {
      const spaces = t.objectStore("spaces");
      const existing = await req<SpaceMeta[]>(spaces.getAll());
      if (existing.some((space) => space.ownerTag === s.ownerTag)) return false;
      spaces.add(s);
      t.objectStore("records").add(profile);
      return true;
    });
  }
  async touchSpace(spaceId: string, at: number) {
    return withStore(["spaces"], "readwrite", async (t) => {
      const spaces = t.objectStore("spaces");
      const s = await req<SpaceMeta | undefined>(spaces.get(spaceId));
      if (!s) return undefined;
      if (at > s.lastSeenAt) {
        s.lastSeenAt = at;
        spaces.put(s);
      }
      return s;
    });
  }
  async deleteSpace(spaceId: string) {
    await withStore(["spaces", "records"], "readwrite", async (t) => {
      t.objectStore("spaces").delete(spaceId);
      const recs = t.objectStore("records");
      const keys = await req(recs.index("bySpace").getAllKeys(spaceId));
      for (const k of keys) recs.delete(k);
    });
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
  async putRecord(r: RecordRow, expected?: RecordRow) {
    return withStore(["spaces", "records"], "readwrite", async (t) => {
      const space = await req<SpaceMeta | undefined>(t.objectStore("spaces").get(r.spaceId));
      if (!space || isExpired(space)) return false;
      const records = t.objectStore("records");
      if (expected && !sameRecord(await req(records.get([r.spaceId, r.id])), expected)) return false;
      records.put(r);
      return true;
    });
  }
  async deleteRecord(spaceId: string, id: string) {
    await withStore(["records"], "readwrite", (t) => void t.objectStore("records").delete([spaceId, id]));
  }
}
