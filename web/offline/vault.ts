/**
 * Borradores manuales sin conexión, cifrados en el dispositivo.
 *
 * Excepción explícita y documentada a «datos clínicos solo en memoria» (CLAUDE.md):
 * - Un espacio por profesional y por día, protegido con su propia frase de
 *   desbloqueo. Otro profesional del mismo dispositivo no puede abrirlo.
 * - Todo el contenido (plantillas, textos, títulos, estados) va cifrado. En claro
 *   solo queda lo necesario para abrir y vencer el espacio: etiqueta del
 *   profesional (huella), corte diario, sal e IV.
 * - En el corte diario (23:59 America/Santiago) el espacio se elimina completo,
 *   aunque haya borradores sin sincronizar, y también si el reloj del equipo
 *   retrocede. Lo ya sincronizado se reduce a una referencia sin contenido.
 * - Desbloquear es local: no habla con el servidor ni prolonga la sesión.
 */
import {
  LOCAL_SYNC_LABEL,
  type LocalSyncStatus,
  OFFLINE_MAX_DRAFTS,
  OFFLINE_MAX_TEXT,
  type OfflineConflictReason,
  type OfflinePackage,
  type OfflineSyncRequest,
  type OfflineSyncResponse,
} from "../../shared/offline";
import type { Template } from "../../shared/types";
import { createKey, ownerTag, PBKDF2_ITERATIONS, randomId, type Sealed, seal, unseal, unwrap, type WrappedKey } from "./crypto";

export interface SpaceMeta {
  spaceId: string;
  ownerTag: string;
  cutoffAt: number;
  /** Mayor hora vista (detecta un reloj que retrocede). */
  lastSeenAt: number;
  /** horaServidor - horaEquipo al preparar el dispositivo. */
  clockDelta: number;
  key: WrappedKey;
  createdAt: number;
  v: 1;
}

export interface RecordRow extends Sealed {
  spaceId: string;
  id: string;
}

/** Almacenamiento subyacente (IndexedDB en el navegador; memoria en pruebas). */
export interface Backend {
  listSpaces(): Promise<SpaceMeta[]>;
  createSpace(s: SpaceMeta, profile: RecordRow): Promise<boolean>;
  touchSpace(spaceId: string, at: number): Promise<SpaceMeta | undefined>;
  /** Elimina el espacio y todos sus registros. */
  deleteSpace(spaceId: string): Promise<void>;
  listRecords(spaceId: string): Promise<RecordRow[]>;
  getRecord(spaceId: string, id: string): Promise<RecordRow | undefined>;
  putRecord(r: RecordRow, expected?: RecordRow): Promise<boolean>;
  deleteRecord(spaceId: string, id: string): Promise<void>;
}

/** El IV cambia en cada cifrado y permite comparar el registro sin descifrarlo. */
export function sameRecord(current: RecordRow | undefined, expected: RecordRow) {
  return current !== undefined && current.iv.length === expected.iv.length &&
    current.iv.every((byte, index) => byte === expected.iv[index]);
}

export interface OfflineProfile {
  professional: { id: string; name: string };
  templates: Template[];
  idleMinutes: number;
}

export interface LocalDraft {
  id: string;
  templateId: string;
  templateVersion: number;
  templateName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Sube con cada guardado local. */
  revision: number;
  /** Última revisión aceptada por el servidor (0 = nunca). */
  syncedRevision: number;
  interviewId: string | null;
  error: string | null;
  conflict: { reason: OfflineConflictReason; interviewId: string; message: string } | null;
  fields: Record<string, string>;
  /** Ya sincronizado: se eliminó el contenido del dispositivo. */
  stub: boolean;
}

export const CLOCK_BACK_TOLERANCE_MS = 10 * 60_000;
const PROFILE = "perfil";
const draftKey = (id: string) => `borrador:${id}`;
const aad = (spaceId: string, id: string) => `${spaceId}/${id}`;

export function draftStatus(d: LocalDraft): LocalSyncStatus {
  if (d.stub || (d.interviewId && d.syncedRevision >= d.revision)) return "sincronizado";
  if (d.conflict || d.error) return "error";
  return "pendiente";
}
export const draftStatusLabel = (d: LocalDraft) => LOCAL_SYNC_LABEL[draftStatus(d)];

/** ¿El espacio venció? (corte diario o reloj que retrocede) */
export function isExpired(s: SpaceMeta, deviceNow = Date.now()) {
  const now = deviceNow + s.clockDelta;
  return now >= s.cutoffAt || now < s.lastSeenAt - CLOCK_BACK_TOLERANCE_MS;
}

/** Elimina los espacios vencidos. Se ejecuta antes de mostrar cualquier dato. */
export async function purgeExpired(b: Backend, deviceNow = Date.now()) {
  let n = 0;
  for (const s of await b.listSpaces()) {
    if (isExpired(s, deviceNow)) {
      await b.deleteSpace(s.spaceId);
      n++;
    }
  }
  return n;
}

export async function liveSpaces(b: Backend) {
  await purgeExpired(b);
  return b.listSpaces();
}

export async function spaceFor(b: Backend, professionalId: string) {
  const tag = await ownerTag(professionalId);
  return (await liveSpaces(b)).find((s) => s.ownerTag === tag);
}

export class OfflineVault {
  private key: CryptoKey | null;

  private constructor(
    private b: Backend,
    public space: SpaceMeta,
    key: CryptoKey,
    public profile: OfflineProfile,
  ) {
    this.key = key;
  }

  /** Prepara el dispositivo con el paquete descargado del servidor (requiere conexión y sesión). */
  static async prepare(b: Backend, pkg: OfflinePackage, passphrase: string, idleMinutes: number, iterations = PBKDF2_ITERATIONS) {
    const tag = await ownerTag(pkg.professional.id);
    const existing = (await liveSpaces(b)).find((s) => s.ownerTag === tag);
    if (existing) throw new Error("Este dispositivo ya está preparado hoy: desbloquéalo con tu frase.");
    const { key, wrapped } = await createKey(passphrase, iterations);
    const delta = Date.parse(pkg.serverTime) - Date.now();
    const space: SpaceMeta = {
      spaceId: randomId(),
      ownerTag: tag,
      cutoffAt: Date.parse(pkg.cutoffAt),
      lastSeenAt: Date.now() + delta,
      clockDelta: delta,
      key: wrapped,
      createdAt: Date.now() + delta,
      v: 1,
    };
    const profile: OfflineProfile = { professional: pkg.professional, templates: pkg.templates, idleMinutes };
    const sealed = await seal(key, aad(space.spaceId, PROFILE), profile);
    if (isExpired(space) || !(await b.createSpace(space, { spaceId: space.spaceId, id: PROFILE, ...sealed })))
      throw new Error("El período terminó o el dispositivo ya está preparado. Vuelve a abrir el modo sin conexión.");
    return new OfflineVault(b, space, key, profile);
  }

  /** Abre el espacio con la frase. Local: no contacta al servidor. */
  static async unlock(b: Backend, space: SpaceMeta, passphrase: string) {
    if (isExpired(space)) {
      await b.deleteSpace(space.spaceId);
      throw new Error("Los borradores de este dispositivo vencieron en el corte diario y se eliminaron.");
    }
    const key = await unwrap(passphrase, space.key);
    const row = await b.getRecord(space.spaceId, PROFILE);
    if (!row) throw new Error("El espacio está incompleto.");
    const profile = await unseal<OfflineProfile>(key, aad(space.spaceId, PROFILE), row);
    const v = new OfflineVault(b, space, key, profile);
    await v.touch();
    return v;
  }

  get locked() {
    return this.key === null;
  }

  /** Olvida la clave en memoria. Los datos siguen cifrados hasta el corte. */
  lock() {
    this.key = null;
  }

  now() {
    return Date.now() + this.space.clockDelta;
  }

  private requireKey() {
    if (!this.key) throw new Error("Los borradores están bloqueados.");
    if (isExpired(this.space)) throw new Error("Los borradores vencieron en el corte diario.");
    return this.key;
  }

  private async write(id: string, value: unknown, expected?: RecordRow) {
    const s = await seal(this.requireKey(), aad(this.space.spaceId, id), value);
    this.requireKey();
    const saved = await this.b.putRecord({ spaceId: this.space.spaceId, id, ...s }, expected);
    if (!saved) await this.touch();
    return saved;
  }

  private async touch() {
    this.requireKey();
    const current = await this.b.touchSpace(this.space.spaceId, this.now());
    if (!current || isExpired(current)) {
      this.lock();
      throw new Error("El espacio local venció o se eliminó.");
    }
    this.space = current;
  }

  async updateTemplates(pkg: OfflinePackage) {
    if (pkg.professional.id !== this.profile.professional.id) throw new Error("El paquete es de otro profesional.");
    this.profile = { ...this.profile, templates: pkg.templates };
    await this.write(PROFILE, this.profile);
  }

  async drafts(): Promise<LocalDraft[]> {
    const key = this.requireKey();
    const rows = (await this.b.listRecords(this.space.spaceId)).filter((r) => r.id.startsWith("borrador:"));
    const out = await Promise.all(rows.map((r) => unseal<LocalDraft>(key, aad(this.space.spaceId, r.id), r)));
    this.requireKey();
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async readDraft(id: string) {
    const row = await this.b.getRecord(this.space.spaceId, draftKey(id));
    if (!row) return undefined;
    const draft = await unseal<LocalDraft>(this.requireKey(), aad(this.space.spaceId, row.id), row);
    this.requireKey();
    return { row, draft };
  }

  async draft(id: string): Promise<LocalDraft | undefined> {
    return (await this.readDraft(id))?.draft;
  }

  async newDraft(templateId: string): Promise<LocalDraft> {
    const t = this.profile.templates.find((x) => x.id === templateId);
    if (!t) throw new Error("La plantilla no está disponible sin conexión.");
    if ((await this.drafts()).filter((d) => !d.stub).length >= OFFLINE_MAX_DRAFTS)
      throw new Error(`Máximo ${OFFLINE_MAX_DRAFTS} borradores en este dispositivo. Sincroniza antes de crear más.`);
    const at = new Date(this.now()).toISOString();
    const when = new Date(at).toLocaleString("es-CL", { timeZone: "America/Santiago", dateStyle: "short", timeStyle: "short" });
    const d: LocalDraft = {
      id: randomId(),
      templateId: t.id,
      templateVersion: t.version,
      templateName: `${t.name} (v${t.version})`,
      title: `Anamnesis sin conexión, ${when}`,
      createdAt: at,
      updatedAt: at,
      revision: 1,
      syncedRevision: 0,
      interviewId: null,
      error: null,
      conflict: null,
      fields: {},
      stub: false,
    };
    await this.write(draftKey(d.id), d);
    return d;
  }

  template(d: LocalDraft) {
    return this.profile.templates.find((t) => t.id === d.templateId && t.version === d.templateVersion);
  }

  /**
   * Guarda el texto escrito. `baseRevision` es la revisión que se estaba editando:
   * si otra pestaña guardó antes, se rechaza en vez de pisar su cambio.
   */
  async saveFields(id: string, fields: Record<string, string>, baseRevision: number): Promise<LocalDraft> {
    const current = await this.readDraft(id);
    if (!current) throw new Error("El borrador ya no existe en este dispositivo.");
    const { draft: cur, row } = current;
    if (cur.stub) throw new Error("Este borrador ya se sincronizó: edítalo en Mis anamnesis.");
    if (cur.revision !== baseRevision) throw new StaleDraftError(cur);
    for (const v of Object.values(fields))
      if (v.length > OFFLINE_MAX_TEXT) throw new Error("Un campo supera 5.000 caracteres.");
    const next: LocalDraft = {
      ...cur,
      fields,
      revision: cur.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
      error: null,
    };
    if (!(await this.write(draftKey(id), next, row))) {
      const latest = await this.draft(id);
      if (latest) throw new StaleDraftError(latest);
      throw new Error("El borrador ya no existe en este dispositivo.");
    }
    await this.touch();
    return next;
  }

  async deleteDraft(id: string) {
    this.requireKey();
    await this.b.deleteRecord(this.space.spaceId, draftKey(id));
  }

  /** Resolución explícita de un conflicto: el borrador se enviará como anamnesis nueva. */
  async asNewCopy(id: string) {
    const cur = await this.draft(id);
    if (!cur) throw new Error("El borrador ya no existe en este dispositivo.");
    const next: LocalDraft = {
      ...cur,
      id: randomId(),
      revision: 1,
      syncedRevision: 0,
      interviewId: null,
      error: null,
      conflict: null,
      title: `${cur.title} (copia)`,
    };
    await this.write(draftKey(next.id), next);
    await this.b.deleteRecord(this.space.spaceId, draftKey(id));
    return next;
  }

  /** Elimina todo el espacio de este dispositivo (decisión explícita del profesional). */
  async destroy() {
    this.key = null;
    await this.b.deleteSpace(this.space.spaceId);
  }

  /**
   * Envía los borradores pendientes. `sessionProfessionalId` es el de la sesión
   * del servidor: un espacio de otro profesional nunca se sincroniza con ella.
   */
  async syncAll(sessionProfessionalId: string, send: SendFn): Promise<SyncSummary> {
    if (sessionProfessionalId !== this.profile.professional.id)
      throw new Error("Estos borradores pertenecen a otro profesional: inicia sesión con su cuenta para sincronizarlos.");
    const summary: SyncSummary = { synced: 0, failed: 0, offline: false };
    for (const d of await this.drafts()) {
      if (draftStatus(d) === "sincronizado" || d.conflict) continue;
      const sent = d.revision;
      const body: OfflineSyncRequest = {
        clientId: d.id,
        revision: sent,
        templateId: d.templateId,
        templateVersion: d.templateVersion,
        fields: d.fields,
        createdAt: d.createdAt,
      };
      let r: SendResult;
      try {
        r = await send(body);
      } catch {
        summary.offline = true; // sin conexión: sigue «Pendiente de sincronizar»
        break;
      }
      // Una respuesta de red puede coincidir con una edición o el borrado
      // de otra pestaña. Solo se escribe sobre el registro que se acaba de leer.
      while (true) {
        const current = await this.readDraft(d.id);
        if (!current || current.draft.syncedRevision >= sent || current.draft.conflict) break;
        const { draft: cur, row } = current;
        let next: LocalDraft;
        if (r.ok) {
          const ok = r.body as OfflineSyncResponse;
          const done = cur.revision === sent;
          next = {
            ...cur, interviewId: ok.interviewId, syncedRevision: sent, error: null, conflict: null,
            ...(done ? { fields: {}, stub: true } : {}),
          };
        } else {
          next = { ...cur, error: r.body.message ?? "No se pudo sincronizar." };
          if (r.status === 409 && r.body.error === "conflicto_sincronizacion") {
            next.conflict = {
              reason: r.body.reason as OfflineConflictReason,
              interviewId: String(r.body.interviewId ?? ""),
              message: r.body.message ?? "",
            };
          }
        }
        if (!(await this.write(draftKey(d.id), next, row))) continue;
        if (r.ok) summary.synced++;
        else summary.failed++;
        break;
      }
      if (r.status === 401) break;
    }
    return summary;
  }
}

export class StaleDraftError extends Error {
  constructor(public current: LocalDraft) {
    super("Este borrador cambió en otra pestaña. Se cargó la versión más reciente.");
    this.name = "StaleDraftError";
  }
}

export interface SendResult {
  ok: boolean;
  status: number;
  body: { error?: string; message?: string; reason?: string; interviewId?: string } & Partial<OfflineSyncResponse>;
}
export type SendFn = (req: OfflineSyncRequest) => Promise<SendResult>;
export interface SyncSummary {
  synced: number;
  failed: number;
  offline: boolean;
}

/** Backend en memoria (pruebas). */
export class MemoryBackend implements Backend {
  spaces = new Map<string, SpaceMeta>();
  records = new Map<string, RecordRow>();
  async listSpaces() {
    return [...this.spaces.values()].map((s) => structuredClone(s));
  }
  async createSpace(s: SpaceMeta, profile: RecordRow) {
    if ([...this.spaces.values()].some((space) => space.ownerTag === s.ownerTag)) return false;
    this.spaces.set(s.spaceId, structuredClone(s));
    this.records.set(`${s.spaceId}/${profile.id}`, structuredClone(profile));
    return true;
  }
  async touchSpace(id: string, at: number) {
    const s = this.spaces.get(id);
    if (!s) return undefined;
    s.lastSeenAt = Math.max(s.lastSeenAt, at);
    return structuredClone(s);
  }
  async deleteSpace(id: string) {
    this.spaces.delete(id);
    for (const k of [...this.records.keys()]) if (k.startsWith(`${id}/`)) this.records.delete(k);
  }
  async listRecords(spaceId: string) {
    return [...this.records.values()].filter((r) => r.spaceId === spaceId).map((r) => structuredClone(r));
  }
  async getRecord(spaceId: string, id: string) {
    const r = this.records.get(`${spaceId}/${id}`);
    return r ? structuredClone(r) : undefined;
  }
  async putRecord(r: RecordRow, expected?: RecordRow) {
    const key = `${r.spaceId}/${r.id}`;
    const space = this.spaces.get(r.spaceId);
    if (!space || isExpired(space) || (expected && !sameRecord(this.records.get(key), expected))) return false;
    this.records.set(key, structuredClone(r));
    return true;
  }
  async deleteRecord(spaceId: string, id: string) {
    this.records.delete(`${spaceId}/${id}`);
  }
}
