/**
 * Almacenamiento en memoria (modo demostración). Toda lectura exige el
 * identificador del profesional: un recurso ajeno se comporta como inexistente.
 * La implementación PostgreSQL (etapa 5) debe cumplir la misma interfaz.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Consent, InterviewStatus, Segment, SpeakerRole, Template } from "../shared/types";
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

export interface Store {
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
    return removed;
  }
}
