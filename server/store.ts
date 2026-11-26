/**
 * Almacenamiento en memoria (modo demostración). Toda lectura exige el
 * identificador del profesional: un recurso ajeno se comporta como inexistente.
 * La implementación PostgreSQL (etapa 5) debe cumplir la misma interfaz.
 */
import { randomBytes, randomUUID } from "node:crypto";
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
  retentionMinutes: number;
}

export interface Session {
  id: string;
  professionalId: string;
  expiresAt: number;
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

export interface Store {
  saveTemplate(t: TemplateRecord): void;
  getTemplate(ownerId: string, id: string): TemplateRecord | undefined;
  listTemplates(ownerId: string): TemplateRecord[];
  deleteTemplate(ownerId: string, id: string): boolean;
  putFile(f: Omit<FileRecord, "id">): FileRecord;
  getFile(ownerId: string, id: string): FileRecord | undefined;
  deleteFile(ownerId: string, id: string): void;
  putImport(p: Omit<PendingImport, "id" | "expiresAt">, ttlMs: number): PendingImport;
  getImport(ownerId: string, id: string): PendingImport | undefined;
  deleteImport(ownerId: string, id: string): void;
  getProfessional(id: string): Professional | undefined;
  upsertProfessional(p: Professional): void;
  createSession(professionalId: string, ttlMs: number): Session;
  getSession(id: string): Session | undefined;
  deleteSession(id: string): void;
  createInterview(ownerId: string, template: Template, title: string): InterviewRecord;
  getInterview(ownerId: string, id: string): InterviewRecord | undefined;
  listInterviews(ownerId: string): InterviewRecord[];
  deleteInterview(ownerId: string, id: string): boolean;
  /** Elimina lo vencido; devuelve los ids eliminados. */
  sweep(now: number): string[];
}

export class MemoryStore implements Store {
  private professionals = new Map<string, Professional>();
  private sessions = new Map<string, Session>();
  private interviews = new Map<string, InterviewRecord>();
  private templates = new Map<string, TemplateRecord>();
  private files = new Map<string, FileRecord>();
  private imports = new Map<string, PendingImport>();

  saveTemplate(t: TemplateRecord) {
    this.templates.set(t.id, t);
  }
  getTemplate(ownerId: string, id: string) {
    const t = this.templates.get(id);
    return t && t.ownerId === ownerId ? t : undefined;
  }
  listTemplates(ownerId: string) {
    return [...this.templates.values()].filter((t) => t.ownerId === ownerId).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  deleteTemplate(ownerId: string, id: string) {
    if (!this.getTemplate(ownerId, id)) return false;
    this.templates.delete(id);
    return true;
  }
  putFile(f: Omit<FileRecord, "id">) {
    const rec = { ...f, id: `file_${randomUUID()}` };
    this.files.set(rec.id, rec);
    return rec;
  }
  getFile(ownerId: string, id: string) {
    const f = this.files.get(id);
    return f && f.ownerId === ownerId ? f : undefined;
  }
  deleteFile(ownerId: string, id: string) {
    if (this.getFile(ownerId, id)) this.files.delete(id);
  }
  putImport(p: Omit<PendingImport, "id" | "expiresAt">, ttlMs: number) {
    const rec = { ...p, id: p.analysis.importId, expiresAt: Date.now() + ttlMs };
    this.imports.set(rec.id, rec);
    return rec;
  }
  getImport(ownerId: string, id: string) {
    const r = this.imports.get(id);
    return r && r.ownerId === ownerId && r.expiresAt > Date.now() ? r : undefined;
  }
  deleteImport(ownerId: string, id: string) {
    if (this.getImport(ownerId, id)) this.imports.delete(id);
  }

  getProfessional(id: string) {
    return this.professionals.get(id);
  }
  upsertProfessional(p: Professional) {
    this.professionals.set(p.id, p);
  }
  createSession(professionalId: string, ttlMs: number): Session {
    const s = { id: randomBytes(32).toString("base64url"), professionalId, expiresAt: Date.now() + ttlMs };
    this.sessions.set(s.id, s);
    return s;
  }
  getSession(id: string) {
    const s = this.sessions.get(id);
    if (s && s.expiresAt < Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }
  deleteSession(id: string) {
    this.sessions.delete(id);
  }
  createInterview(ownerId: string, template: Template, title: string): InterviewRecord {
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
    this.interviews.set(rec.id, rec);
    return rec;
  }
  getInterview(ownerId: string, id: string) {
    const r = this.interviews.get(id);
    return r && r.ownerId === ownerId ? r : undefined;
  }
  listInterviews(ownerId: string) {
    return [...this.interviews.values()]
      .filter((r) => r.ownerId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  deleteInterview(ownerId: string, id: string) {
    const r = this.getInterview(ownerId, id);
    if (!r) return false;
    this.interviews.delete(id);
    return true;
  }
  sweep(now: number) {
    const removed: string[] = [];
    for (const r of this.interviews.values()) {
      const p = this.professionals.get(r.ownerId);
      const ttl = (p?.retentionMinutes ?? 60) * 60_000;
      if (r.lastActivity + ttl < now && r.status !== "escuchando") {
        this.interviews.delete(r.id);
        removed.push(r.id);
      }
    }
    for (const s of this.sessions.values()) if (s.expiresAt < now) this.sessions.delete(s.id);
    for (const imp of this.imports.values()) {
      if (imp.expiresAt < now) {
        this.imports.delete(imp.id);
        // El archivo de una importación no confirmada se descarta.
        if (![...this.templates.values()].some((t) => t.source?.fileId === imp.fileId)) this.files.delete(imp.fileId);
      }
    }
    return removed;
  }
}
