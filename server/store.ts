/**
 * Almacenamiento. Toda lectura y escritura exige el identificador del
 * profesional obtenido de la sesión del servidor: un recurso ajeno se comporta
 * como inexistente. Dos implementaciones con la misma interfaz:
 * - MemoryStore: modo demostración y pruebas sin base de datos.
 * - PgStore (server/db/pgStore.ts): PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import type {
  Consent,
  ImportAnalysis,
  InterviewStatus,
  Segment,
  SourceKind,
  SpeakerRole,
  Template,
  TemplateSection,
  TemplateSource,
} from "../shared/types";
import type { ProfessionalFieldState } from "./extraction/merge";

export interface Professional {
  id: string;
  name: string;
  /** Días sin actividad tras los que se elimina del servidor. null = nunca (predeterminado). */
  historyRetentionDays: number | null;
  idleMinutes: number;
}

export interface InterviewRecord {
  id: string;
  ownerId: string;
  title: string;
  createdAt: number;
  lastActivity: number;
  status: InterviewStatus;
  template: Template;
  consent: Consent | null;
  segments: Segment[];
  speakerRoles: Record<number, SpeakerRole>;
  prof: Record<string, ProfessionalFieldState | undefined>;
  pauseReason: string | null;
  finalizedAt: number | null;
}

export interface TemplateVersionRecord {
  version: number;
  createdAt: number;
  note: string;
  sections: TemplateSection[];
}

export interface TemplateRecord {
  id: string;
  ownerId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  source?: TemplateSource;
  versions: TemplateVersionRecord[];
}

export interface FileRecord {
  id: string;
  ownerId: string;
  kind: SourceKind;
  fileName: string;
  bytes: Buffer;
}

export interface PendingImport {
  id: string;
  ownerId: string;
  expiresAt: number;
  fileId: string;
  analysis: ImportAnalysis;
  /** Marcadores y párrafos válidos detectados, para validar lo confirmado. */
  validTargets: Set<string>;
}

export interface InterviewFilter {
  /** Fecha de creación desde/hasta (inclusive, ms). */
  from?: number;
  to?: number;
  state?: "borrador" | "revisada";
}

export interface Store {
  readonly kind: "memory" | "postgres";
  getProfessional(id: string): Promise<Professional | undefined>;
  upsertProfessional(p: Professional): Promise<void>;

  createInterview(ownerId: string, template: Template, title: string): Promise<InterviewRecord>;
  getInterview(ownerId: string, id: string): Promise<InterviewRecord | undefined>;
  listInterviews(ownerId: string, filter?: InterviewFilter): Promise<InterviewRecord[]>;
  /** Guarda una entrevista existente; nunca recrea una eliminada ni escribe en una ajena. */
  saveInterview(rec: InterviewRecord): Promise<boolean>;
  deleteInterview(ownerId: string, id: string): Promise<boolean>;
  countInterviews(ownerId: string): Promise<number>;

  saveTemplate(t: TemplateRecord): Promise<void>;
  getTemplate(ownerId: string, id: string): Promise<TemplateRecord | undefined>;
  listTemplates(ownerId: string): Promise<TemplateRecord[]>;
  deleteTemplate(ownerId: string, id: string): Promise<boolean>;

  putFile(f: Omit<FileRecord, "id">): Promise<FileRecord>;
  getFile(ownerId: string, id: string): Promise<FileRecord | undefined>;
  deleteFile(ownerId: string, id: string): Promise<void>;
  fileInUse(ownerId: string, fileId: string): Promise<boolean>;

  putImport(p: Omit<PendingImport, "id" | "expiresAt">, ttlMs: number): Promise<PendingImport>;
  getImport(ownerId: string, id: string): Promise<PendingImport | undefined>;
  deleteImport(ownerId: string, id: string): Promise<void>;

  /** Última actividad de una sesión (bloqueo por inactividad, exigido en servidor). */
  getActivity(sessionId: string): Promise<number | undefined>;
  touchActivity(sessionId: string, at: number): Promise<void>;
  deleteActivity(sessionId: string): Promise<void>;

  /**
   * Limpieza periódica del servidor. Solo elimina anamnesis de profesionales que
   * configuraron explícitamente la eliminación del historial; devuelve los ids eliminados.
   */
  sweep(now: number): Promise<string[]>;
  close(): Promise<void>;
}

export function matchesFilter(r: { createdAt: number; status: InterviewStatus }, f: InterviewFilter = {}) {
  if (f.from !== undefined && r.createdAt < f.from) return false;
  if (f.to !== undefined && r.createdAt > f.to) return false;
  if (f.state === "revisada" && r.status !== "finalizada") return false;
  if (f.state === "borrador" && r.status === "finalizada") return false;
  return true;
}

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private professionals = new Map<string, Professional>();
  private interviews = new Map<string, InterviewRecord>();
  private templates = new Map<string, TemplateRecord>();
  private files = new Map<string, FileRecord>();
  private imports = new Map<string, PendingImport>();
  private activity = new Map<string, number>();

  async getProfessional(id: string) {
    const p = this.professionals.get(id);
    return p ? { ...p } : undefined;
  }
  async upsertProfessional(p: Professional) {
    this.professionals.set(p.id, { ...p });
  }

  async createInterview(ownerId: string, template: Template, title: string) {
    const now = Date.now();
    const rec: InterviewRecord = {
      id: randomUUID(),
      ownerId,
      title,
      createdAt: now,
      lastActivity: now,
      status: "preparada",
      template: structuredClone(template),
      consent: null,
      segments: [],
      speakerRoles: {},
      prof: {},
      pauseReason: null,
      finalizedAt: null,
    };
    this.interviews.set(rec.id, structuredClone(rec));
    return rec;
  }
  async getInterview(ownerId: string, id: string) {
    const r = this.interviews.get(id);
    return r && r.ownerId === ownerId ? structuredClone(r) : undefined;
  }
  async listInterviews(ownerId: string, filter?: InterviewFilter) {
    return [...this.interviews.values()]
      .filter((r) => r.ownerId === ownerId && matchesFilter(r, filter))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => structuredClone(r));
  }
  async saveInterview(rec: InterviewRecord) {
    const cur = this.interviews.get(rec.id);
    if (!cur || cur.ownerId !== rec.ownerId) return false;
    this.interviews.set(rec.id, structuredClone(rec));
    return true;
  }
  async deleteInterview(ownerId: string, id: string) {
    const r = this.interviews.get(id);
    if (!r || r.ownerId !== ownerId) return false;
    this.interviews.delete(id);
    return true;
  }
  async countInterviews(ownerId: string) {
    return [...this.interviews.values()].filter((r) => r.ownerId === ownerId).length;
  }

  async saveTemplate(t: TemplateRecord) {
    const cur = this.templates.get(t.id);
    if (cur && cur.ownerId !== t.ownerId) return;
    this.templates.set(t.id, structuredClone(t));
  }
  async getTemplate(ownerId: string, id: string) {
    const t = this.templates.get(id);
    return t && t.ownerId === ownerId ? structuredClone(t) : undefined;
  }
  async listTemplates(ownerId: string) {
    return [...this.templates.values()]
      .filter((t) => t.ownerId === ownerId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => structuredClone(t));
  }
  async deleteTemplate(ownerId: string, id: string) {
    const t = this.templates.get(id);
    if (!t || t.ownerId !== ownerId) return false;
    this.templates.delete(id);
    return true;
  }

  async putFile(f: Omit<FileRecord, "id">) {
    const rec = { ...f, id: `file_${randomUUID()}` };
    this.files.set(rec.id, rec);
    return rec;
  }
  async getFile(ownerId: string, id: string) {
    const f = this.files.get(id);
    return f && f.ownerId === ownerId ? f : undefined;
  }
  async deleteFile(ownerId: string, id: string) {
    const f = this.files.get(id);
    if (f && f.ownerId === ownerId) this.files.delete(id);
  }
  async fileInUse(ownerId: string, fileId: string) {
    return (
      [...this.templates.values()].some((t) => t.ownerId === ownerId && t.source?.fileId === fileId) ||
      [...this.interviews.values()].some((r) => r.ownerId === ownerId && r.template.source?.fileId === fileId)
    );
  }

  async putImport(p: Omit<PendingImport, "id" | "expiresAt">, ttlMs: number) {
    const rec = { ...p, id: p.analysis.importId, expiresAt: Date.now() + ttlMs };
    this.imports.set(rec.id, rec);
    return rec;
  }
  async getImport(ownerId: string, id: string) {
    const r = this.imports.get(id);
    return r && r.ownerId === ownerId && r.expiresAt > Date.now() ? r : undefined;
  }
  async deleteImport(ownerId: string, id: string) {
    const r = this.imports.get(id);
    if (r && r.ownerId === ownerId) this.imports.delete(id);
  }

  async getActivity(sessionId: string) {
    return this.activity.get(sessionId);
  }
  async touchActivity(sessionId: string, at: number) {
    this.activity.set(sessionId, at);
  }
  async deleteActivity(sessionId: string) {
    this.activity.delete(sessionId);
  }

  async sweep(now: number) {
    const removed: string[] = [];
    for (const r of [...this.interviews.values()]) {
      const days = this.professionals.get(r.ownerId)?.historyRetentionDays ?? null;
      if (days === null) continue; // sin política explícita: nunca se elimina
      if (r.lastActivity + days * 86_400_000 < now && r.status !== "escuchando") {
        this.interviews.delete(r.id);
        removed.push(r.id);
      }
    }
    for (const imp of [...this.imports.values()]) {
      if (imp.expiresAt < now) {
        this.imports.delete(imp.id);
        // El archivo de una importación no confirmada se descarta.
        if (!(await this.fileInUse(imp.ownerId, imp.fileId))) this.files.delete(imp.fileId);
      }
    }
    return removed;
  }
  async close() {}
}
