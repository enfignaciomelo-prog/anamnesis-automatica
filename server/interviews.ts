/**
 * Ciclo de vida de una entrevista: consentimiento, escucha, propuestas,
 * revisión del profesional y finalización. Toda operación verifica el dueño.
 *
 * Persistencia: cada cambio se escribe en el almacenamiento (memoria o
 * PostgreSQL). Las entrevistas activas (escuchando o con pantallas abiertas)
 * se mantienen además en memoria del proceso; las escrituras de una misma
 * entrevista se encadenan para conservar el orden.
 */
import type { ServerResponse } from "node:http";
import type {
  Consent,
  FieldState,
  InterviewSnapshot,
  InterviewSummary,
  SpeakerRole,
  Template,
} from "../shared/types";
import { GENERIC_TEMPLATE, allFields } from "../shared/template-generic";
import type { Config } from "./config";
import { DEMO_SCRIPT } from "./demo/script";
import { extractDemo } from "./extraction/demoExtractor";
import { computeFields } from "./extraction/merge";
import { HttpError } from "./http";
import { logError, logEvent } from "./log";
import type { InterviewFilter, InterviewRecord, Store } from "./store";
import { DemoSource } from "./transcription/demoSource";
import type { TranscriptionSource } from "./transcription/source";

export type Command = "iniciar" | "pausar" | "reanudar" | "detener";

const ROLES: SpeakerRole[] = ["profesional", "paciente", "acompanante", "sin_asignar"];
const MAX_TEXT = 5000;

export class InterviewService {
  private sources = new Map<string, TranscriptionSource>();
  private subscribers = new Map<string, Set<ServerResponse>>();
  private disconnectTimers = new Map<string, NodeJS.Timeout>();
  /** Entrevistas activas en este proceso. */
  private live = new Map<string, InterviewRecord>();
  private writes = new Map<string, Promise<unknown>>();

  constructor(
    private store: Store,
    private config: Config,
  ) {}

  private async get(ownerId: string, id: string): Promise<InterviewRecord> {
    const cached = this.live.get(id);
    if (cached) {
      if (cached.ownerId !== ownerId) throw notFound();
      return cached;
    }
    const r = await this.store.getInterview(ownerId, id);
    if (!r) throw notFound();
    return r;
  }

  private retain(r: InterviewRecord) {
    this.live.set(r.id, r);
  }

  private releaseIfIdle(id: string) {
    if (!this.sources.has(id) && !(this.subscribers.get(id)?.size ?? 0)) this.live.delete(id);
  }

  /** Escribe en orden; el resultado indica si el servidor confirmó el guardado. */
  private persist(r: InterviewRecord): Promise<boolean> {
    const snapshot = structuredClone(r);
    const prev = this.writes.get(r.id) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.store.saveInterview(snapshot));
    this.writes.set(r.id, next);
    return next;
  }

  private async commit(r: InterviewRecord) {
    r.lastActivity = Date.now();
    let ok: boolean;
    try {
      ok = await this.persist(r);
    } catch (err) {
      logError("interview_save", err);
      throw new HttpError(503, "error_guardado", "No se pudo guardar en el servidor. Intenta de nuevo.");
    }
    if (!ok) throw notFound();
    this.broadcast(r);
  }

  private requireEditable(r: InterviewRecord) {
    if (r.status === "finalizada")
      throw new HttpError(409, "finalizada", "La entrevista ya fue finalizada y no se puede modificar.");
  }

  async create(ownerId: string, template: Template = GENERIC_TEMPLATE): Promise<InterviewRecord> {
    const n = (await this.store.countInterviews(ownerId)) + 1;
    const when = new Intl.DateTimeFormat("es-CL", {
      timeZone: "America/Santiago",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
    const title = `${this.config.demo ? "Entrevista demo" : "Anamnesis"} ${n}, ${when}`;
    const r = await this.store.createInterview(ownerId, template, title);
    logEvent("interview_created");
    return r;
  }

  fields(r: InterviewRecord): Record<string, FieldState> {
    const items = extractDemo(r.segments, r.speakerRoles, r.template);
    return computeFields(r.template, items, r.prof);
  }

  summary(r: InterviewRecord): InterviewSummary {
    return {
      id: r.id,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.lastActivity).toISOString(),
      status: r.status,
      templateName: `${r.template.name} (v${r.template.version})`,
      title: r.title,
    };
  }

  async snapshot(r: InterviewRecord): Promise<InterviewSnapshot> {
    const owner = await this.store.getProfessional(r.ownerId);
    const ttl = (owner?.retentionMinutes ?? this.config.retentionDefaultMinutes) * 60_000;
    return {
      ...this.summary(r),
      template: r.template,
      consent: r.consent,
      segments: r.segments,
      speakerRoles: r.speakerRoles,
      fields: this.fields(r),
      pauseReason: r.pauseReason,
      finalizedAt: r.finalizedAt ? new Date(r.finalizedAt).toISOString() : null,
      demo: this.config.demo,
      expiresAt: new Date(r.lastActivity + ttl).toISOString(),
    };
  }

  async list(ownerId: string, filter?: InterviewFilter) {
    const rows = await this.store.listInterviews(ownerId, filter);
    // Lo activo en memoria es más reciente que lo guardado.
    return rows.map((r) => this.summary(this.live.get(r.id) ?? r));
  }

  async read(ownerId: string, id: string) {
    return this.snapshot(await this.get(ownerId, id));
  }

  /** Solo para pruebas: registro vivo o guardado. */
  async record(ownerId: string, id: string) {
    const r = await this.get(ownerId, id);
    this.retain(r);
    return r;
  }

  isListening(ownerId: string) {
    return [...this.live.values()].some((r) => r.ownerId === ownerId && r.status === "escuchando");
  }

  async consent(ownerId: string, id: string, givenBy: Consent["givenBy"]) {
    const r = await this.get(ownerId, id);
    this.requireEditable(r);
    if (givenBy !== "paciente" && givenBy !== "representante")
      throw new HttpError(400, "consentimiento_invalido", "Indica quién otorgó el consentimiento.");
    r.consent = { at: new Date().toISOString(), givenBy };
    await this.commit(r);
    logEvent("consent_recorded");
    return this.snapshot(r);
  }

  async command(ownerId: string, id: string, cmd: Command, reason: string | null = null) {
    const r = await this.get(ownerId, id);
    this.requireEditable(r);
    this.retain(r);
    this.applyCommand(r, cmd, reason);
    await this.commit(r);
    this.releaseIfIdle(r.id);
    return this.snapshot(r);
  }

  private applyCommand(r: InterviewRecord, cmd: Command, reason: string | null) {
    const allowed: Record<Command, InterviewRecord["status"][]> = {
      iniciar: ["preparada"],
      pausar: ["escuchando"],
      reanudar: ["pausada"],
      detener: ["escuchando", "pausada"],
    };
    if (!allowed[cmd].includes(r.status))
      throw new HttpError(409, "estado_invalido", "Esa acción no está disponible en el estado actual.");
    if (cmd === "iniciar" && !r.consent)
      throw new HttpError(403, "sin_consentimiento", "Registra el consentimiento antes de activar la escucha.");

    if (cmd === "iniciar") {
      const src = new DemoSource(
        DEMO_SCRIPT,
        {
          onInterim: (speaker, text) => this.emit(r.id, "interim", { speaker, text }),
          onFinal: (seg) => {
            r.segments.push({ ...seg, id: `s${r.segments.length + 1}` });
            for (const sp of new Set(r.segments.map((s) => s.speaker))) r.speakerRoles[sp] ??= "sin_asignar";
            r.lastActivity = Date.now();
            this.persist(r).catch((e) => logError("segment_save", e));
            this.broadcast(r);
          },
          onEnd: () => {
            if (r.status === "escuchando" || r.status === "pausada") {
              r.status = "detenida";
              r.pauseReason = null;
              this.sources.delete(r.id);
              this.persist(r).catch((e) => logError("segment_save", e));
              this.broadcast(r);
              this.releaseIfIdle(r.id);
            }
          },
        },
        this.config.demoSpeed,
      );
      this.sources.set(r.id, src);
      r.status = "escuchando";
      src.start();
    } else if (cmd === "pausar") {
      this.sources.get(r.id)?.pause();
      r.status = "pausada";
      r.pauseReason = reason;
    } else if (cmd === "reanudar") {
      r.status = "escuchando";
      r.pauseReason = null;
      if (this.sources.has(r.id)) this.sources.get(r.id)!.resume();
      else {
        // Tras un reinicio del servidor la fuente demo no existe: se detiene.
        r.status = "detenida";
      }
    } else {
      r.status = "detenida";
      r.pauseReason = null;
      const src = this.sources.get(r.id);
      this.sources.delete(r.id);
      src?.stop();
    }
    logEvent("interview_command", { cmd });
  }

  /** Pausa toda escucha del profesional (cierre de sesión o vencimiento). */
  async pauseAll(ownerId: string, reason: string) {
    for (const r of [...this.live.values()]) {
      if (r.ownerId !== ownerId || r.status !== "escuchando") continue;
      this.applyCommand(r, "pausar", reason);
      await this.commit(r).catch((e) => logError("pause_all", e));
    }
  }

  async setRole(ownerId: string, id: string, speaker: number, role: SpeakerRole) {
    const r = await this.get(ownerId, id);
    this.requireEditable(r);
    if (!ROLES.includes(role) || !(speaker in r.speakerRoles))
      throw new HttpError(400, "rol_invalido", "Hablante o rol no válido.");
    r.speakerRoles[speaker] = role;
    await this.commit(r);
    return this.snapshot(r);
  }

  private field(r: InterviewRecord, fieldId: string) {
    if (!allFields(r.template).some((f) => f.id === fieldId))
      throw new HttpError(400, "campo_invalido", "El campo no existe en la plantilla.");
    return this.fields(r)[fieldId];
  }

  /** Autoguardado del texto que el profesional está escribiendo (no confirma). */
  async saveDraft(ownerId: string, id: string, fieldId: string, value: string) {
    const r = await this.get(ownerId, id);
    this.requireEditable(r);
    this.field(r, fieldId);
    if (value.length > MAX_TEXT) throw new HttpError(400, "texto_largo", "El texto supera 5.000 caracteres.");
    const prev = r.prof[fieldId];
    r.prof[fieldId] = {
      confirmed: prev?.confirmed ?? false,
      value: prev?.value ?? null,
      edited: prev?.edited ?? false,
      ackItemIds: prev?.ackItemIds ?? [],
      draft: value,
    };
    await this.commit(r);
    return { savedAt: new Date(r.lastActivity).toISOString() };
  }

  /** Confirma un campo, opcionalmente con texto del profesional. */
  async confirmField(ownerId: string, id: string, fieldId: string, value: string | null) {
    const r = await this.get(ownerId, id);
    this.requireEditable(r);
    const current = this.field(r, fieldId);
    if (value !== null && value.length > MAX_TEXT)
      throw new HttpError(400, "texto_largo", "El texto supera 5.000 caracteres.");
    const text = value?.trim() || null;
    const finalText = text ?? current.professionalValue ?? current.proposedValue;
    if (finalText === null)
      throw new HttpError(400, "sin_texto", "Escribe un texto o marca el campo como No referido.");
    const prev = r.prof[fieldId];
    r.prof[fieldId] = {
      confirmed: true,
      value: finalText,
      edited: Boolean(prev?.edited) || (text !== null && text !== current.proposedValue),
      ackItemIds: current.items.map((i) => i.id),
      draft: null,
    };
    await this.commit(r);
    return this.snapshot(r);
  }

  async markNotReported(ownerId: string, id: string, fieldId: string) {
    const r = await this.get(ownerId, id);
    this.requireEditable(r);
    const current = this.field(r, fieldId);
    r.prof[fieldId] = {
      confirmed: true,
      value: "No referido",
      edited: true,
      ackItemIds: current.items.map((i) => i.id),
      draft: null,
    };
    await this.commit(r);
    return this.snapshot(r);
  }

  async finalize(ownerId: string, id: string, attested: boolean) {
    const r = await this.get(ownerId, id);
    this.requireEditable(r);
    if (r.status !== "detenida")
      throw new HttpError(409, "escucha_activa", "Detén la escucha antes de finalizar.");
    if (!attested) throw new HttpError(400, "sin_revision", "Confirma que revisaste el borrador completo.");
    const fields = this.fields(r);
    const pending = Object.values(fields).filter((f) => f.status === "requiere_revision").length;
    if (pending) throw new HttpError(409, "revision_pendiente", `Quedan ${pending} campos que requieren revisión.`);
    // Lo propuesto queda confirmado por la revisión explícita del profesional.
    for (const f of Object.values(fields)) {
      if (f.status === "propuesto")
        r.prof[f.fieldId] = {
          confirmed: true,
          value: f.proposedValue,
          edited: false,
          ackItemIds: f.items.map((i) => i.id),
          draft: null,
        };
    }
    r.status = "finalizada";
    r.finalizedAt = Date.now();
    await this.commit(r);
    logEvent("interview_finalized");
    return this.snapshot(r);
  }

  async delete(ownerId: string, id: string) {
    const r = await this.get(ownerId, id);
    this.sources.get(r.id)?.stop();
    this.sources.delete(r.id);
    this.live.delete(r.id);
    await this.writes.get(r.id)?.catch(() => undefined);
    await this.store.deleteInterview(ownerId, id);
    this.closeSubscribers(id);
    logEvent("interview_deleted");
  }

  /** Elimina entrevistas vencidas según la retención de cada profesional. */
  async sweep() {
    for (const id of await this.store.sweep(Date.now())) {
      this.sources.get(id)?.stop();
      this.sources.delete(id);
      this.live.delete(id);
      this.closeSubscribers(id);
      logEvent("interview_expired");
    }
  }

  // ---- Eventos en vivo (Server-Sent Events) ----

  async subscribe(ownerId: string, id: string, res: ServerResponse) {
    const r = await this.get(ownerId, id);
    this.retain(r);
    const set = this.subscribers.get(id) ?? new Set();
    set.add(res);
    this.subscribers.set(id, set);
    const t = this.disconnectTimers.get(id);
    if (t) clearTimeout(t);
    this.disconnectTimers.delete(id);
    this.write(res, "snapshot", await this.snapshot(r));
    res.on("close", () => {
      set.delete(res);
      if (set.size === 0) this.onAllDisconnected(id);
    });
  }

  private onAllDisconnected(id: string) {
    const r = this.live.get(id);
    if (!r || r.status !== "escuchando") {
      this.releaseIfIdle(id);
      return;
    }
    // Sin interfaz conectada no se sigue escuchando: pausa automática.
    const t = setTimeout(() => {
      this.disconnectTimers.delete(id);
      const cur = this.live.get(id);
      if (cur?.status === "escuchando" && !(this.subscribers.get(id)?.size ?? 0)) {
        this.applyCommand(cur, "pausar", "conexion");
        this.commit(cur)
          .catch((e) => logError("auto_pause", e))
          .finally(() => this.releaseIfIdle(id));
      }
    }, this.config.disconnectPauseMs);
    this.disconnectTimers.set(id, t);
  }

  /** Cierra los canales en vivo de un profesional (cierre de sesión o vencimiento). */
  closeOwnerStreams(ownerId: string) {
    for (const [id, r] of [...this.live.entries()]) {
      if (r.ownerId !== ownerId) continue;
      for (const res of this.subscribers.get(id) ?? []) {
        this.write(res, "session_ended", {});
        res.end();
      }
      this.subscribers.delete(id);
      this.releaseIfIdle(id);
    }
  }

  private broadcast(r: InterviewRecord) {
    const set = this.subscribers.get(r.id);
    if (!set?.size) return;
    void this.snapshot(r).then((snap) => {
      for (const res of set) this.write(res, "snapshot", snap);
    });
  }

  private emit(id: string, event: string, data: unknown) {
    for (const res of this.subscribers.get(id) ?? []) this.write(res, event, data);
  }

  private write(res: ServerResponse, event: string, data: unknown) {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private closeSubscribers(id: string) {
    for (const res of this.subscribers.get(id) ?? []) {
      this.write(res, "deleted", {});
      res.end();
    }
    this.subscribers.delete(id);
  }

  heartbeat() {
    for (const set of this.subscribers.values()) for (const res of set) if (!res.writableEnded) res.write(": ping\n\n");
  }

  async shutdown() {
    for (const s of this.sources.values()) s.stop();
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    for (const id of [...this.subscribers.keys()]) for (const res of this.subscribers.get(id) ?? []) res.end();
    this.subscribers.clear();
    await Promise.allSettled([...this.writes.values()]);
  }
}

function notFound() {
  return new HttpError(404, "no_encontrada", "La entrevista no existe o fue eliminada.");
}
