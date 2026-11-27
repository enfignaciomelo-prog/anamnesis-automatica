/**
 * Sincronización de borradores escritos sin conexión (modo manual).
 *
 * - Idempotente: cada borrador del dispositivo (clientId) corresponde a una sola
 *   anamnesis del profesional; reenviar la misma revisión no crea copias.
 * - Sin sobrescritura silenciosa: si la anamnesis cambió en el servidor después
 *   de la última sincronización (edición, finalización o eliminación), se
 *   responde 409 y el dispositivo conserva su copia para que el profesional decida.
 * - La identidad viene de la sesión del servidor; el clientId nunca da acceso a
 *   recursos de otro profesional (el vínculo se busca siempre con el dueño).
 */
import { createHash } from "node:crypto";
import {
  OFFLINE_MAX_TEXT,
  type OfflineConflictReason,
  type OfflinePackage,
  type OfflineSyncRequest,
  type OfflineSyncResponse,
  CONFLICT_TEXT,
} from "../shared/offline";
import { allFields } from "../shared/template-generic";
import type { Template } from "../shared/types";
import type { ProfessionalFieldState } from "./extraction/merge";
import { HttpError } from "./http";
import type { InterviewService } from "./interviews";
import { logEvent } from "./log";
import type { InterviewRecord, Store } from "./store";
import type { TemplateService } from "./templates/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OfflineConflict extends HttpError {
  constructor(
    public reason: OfflineConflictReason,
    public interviewId: string,
  ) {
    super(409, "conflicto_sincronizacion", CONFLICT_TEXT[reason], { reason, interviewId });
  }
}

/** JSON con claves ordenadas: la misma huella aunque PostgreSQL reordene jsonb. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** Huella de todo lo que el profesional puede cambiar en el servidor. */
export function contentHash(r: InterviewRecord) {
  return createHash("sha256")
    .update(
      canonical({
        status: r.status,
        prof: r.prof,
        roles: r.speakerRoles,
        segments: r.segments.length,
        consent: r.consent,
        template: [r.template.id, r.template.version],
      }),
    )
    .digest("hex");
}

export function parseSyncRequest(body: Record<string, unknown>): OfflineSyncRequest {
  const bad = (msg: string) => new HttpError(400, "borrador_invalido", msg);
  const { clientId, revision, templateId, templateVersion, fields, createdAt } = body;
  if (typeof clientId !== "string" || !UUID.test(clientId)) throw bad("Identificador del borrador no válido.");
  if (!Number.isInteger(revision) || (revision as number) < 1 || (revision as number) > 1_000_000)
    throw bad("Revisión no válida.");
  if (typeof templateId !== "string" || templateId.length > 100) throw bad("Plantilla no válida.");
  if (!Number.isInteger(templateVersion) || (templateVersion as number) < 1) throw bad("Versión de plantilla no válida.");
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw bad("Campos no válidos.");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof v !== "string") throw bad("Campos no válidos.");
    if (v.length > OFFLINE_MAX_TEXT) throw new HttpError(400, "texto_largo", "Un campo supera 5.000 caracteres.");
    out[k] = v;
  }
  const created = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(created)) throw bad("Fecha del borrador no válida.");
  return {
    clientId: clientId.toLowerCase(),
    revision: revision as number,
    templateId,
    templateVersion: templateVersion as number,
    fields: out,
    createdAt: new Date(created).toISOString(),
  };
}

/**
 * Texto escrito por el profesional → estado de campos. Todo lo escrito queda
 * como texto del profesional (marcado como edición manual); lo vacío queda
 * «No referido». La revisión y confirmación final siguen siendo obligatorias.
 */
function toProf(template: Template, fields: Record<string, string>) {
  const ids = new Set(allFields(template).map((f) => f.id));
  const prof: Record<string, ProfessionalFieldState> = {};
  for (const [id, raw] of Object.entries(fields)) {
    if (!ids.has(id)) throw new HttpError(400, "campo_invalido", "El borrador tiene un campo que no existe en la plantilla.");
    const value = raw.trim();
    if (!value) continue;
    prof[id] = { confirmed: true, value, edited: true, ackItemIds: [], draft: null };
  }
  return prof;
}

export class OfflineSyncService {
  /** Envíos del mismo borrador se atienden de a uno (dos pestañas o reintentos simultáneos). */
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private store: Store,
    private interviews: InterviewService,
    private templates: TemplateService,
  ) {}

  async package(professional: { id: string; name: string }, cutoffAt: number, now: number): Promise<OfflinePackage> {
    return {
      professional,
      templates: await this.templates.allCurrent(professional.id),
      cutoffAt: new Date(cutoffAt).toISOString(),
      serverTime: new Date(now).toISOString(),
    };
  }

  sync(ownerId: string, req: OfflineSyncRequest): Promise<OfflineSyncResponse> {
    const key = `${ownerId}:${req.clientId}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.apply(ownerId, req));
    this.locks.set(key, next);
    void next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }).catch(() => undefined);
    return next;
  }

  private async apply(ownerId: string, req: OfflineSyncRequest): Promise<OfflineSyncResponse> {
    const link = await this.store.getOfflineLink(ownerId, req.clientId);
    if (link && req.revision <= link.revision) {
      // Reintento (p. ej., se perdió la respuesta): sin efectos.
      logEvent("offline_sync", { result: "duplicado" });
      return { status: "sincronizado", interviewId: link.interviewId, revision: link.revision, duplicate: true };
    }
    const template = await this.templates.resolveVersion(ownerId, req.templateId, req.templateVersion);
    const prof = toProf(template, req.fields);

    let rec: InterviewRecord;
    if (!link) {
      const created = Math.min(Date.parse(req.createdAt), Date.now());
      rec = await this.interviews.createManual(ownerId, template, prof, created);
    } else {
      const cur = await this.interviews.find(ownerId, link.interviewId);
      if (!cur) throw new OfflineConflict("eliminada_en_servidor", link.interviewId);
      if (cur.status === "finalizada") throw new OfflineConflict("finalizada", link.interviewId);
      if (contentHash(cur) !== link.contentHash) throw new OfflineConflict("modificada_en_servidor", link.interviewId);
      if (cur.template.id !== template.id || cur.template.version !== template.version)
        throw new HttpError(400, "plantilla_distinta", "El borrador no puede cambiar de plantilla después de sincronizarse.");
      rec = await this.interviews.replaceManual(cur, prof);
    }
    await this.store.saveOfflineLink({
      ownerId,
      clientId: req.clientId,
      interviewId: rec.id,
      revision: req.revision,
      contentHash: contentHash(rec),
    });
    logEvent("offline_sync", { result: link ? "actualizado" : "creado" });
    return { status: "sincronizado", interviewId: rec.id, revision: req.revision, duplicate: false };
  }
}
