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
import type { AuthSession } from "./auth/types";
import type { Config } from "./config";
import { DEMO_SCRIPT } from "./demo/script";
import { extractDemo } from "./extraction/demoExtractor";
import { computeFields } from "./extraction/merge";
import { HttpError } from "./http";
import { logError, logEvent } from "./log";
import type { InterviewFilter, InterviewRecord, Store } from "./store";
import { DeepgramSource, type AudioCapture, type ConnectDeepgram } from "./transcription/deepgram";
import { DemoSource } from "./transcription/demoSource";
import type { TranscriptionSource } from "./transcription/source";

export type Command = "iniciar" | "pausar" | "reanudar" | "detener";

const ROLES: SpeakerRole[] = ["profesional", "paciente", "acompanante", "sin_asignar"];
const MAX_TEXT = 5000;

export class InterviewService {
  private finishing = new Set<string>();
  private sources = new Map<string, TranscriptionSource>();
  private subscribers = new Map<string, Set<ServerResponse>>();
  private disconnectTimers = new Map<string, NodeJS.Timeout>();
  /** Entrevistas activas en este proceso. */
  private live = new Map<string, InterviewRecord>();
  private writes = new Map<string, Promise<unknown>>();
  /** Sesión que inició o reanudó la escucha de cada entrevista (dueña del micrófono). */
  private listeners = new Map<string, AuthSession>();

  constructor(
    private store: Store,
    private config: Config,
    private connectDeepgram?: ConnectDeepgram,
  ) {}

  private async get(ownerId: string, id: string): Promise<InterviewRecord> {
    const cached = this.live.get(id);
    if (cached) {
      if (cached.ownerId !== ownerId) throw notFound();
      return cached;
    }
    const r = await this.store.getInterview(ownerId, id);
    if (!r) throw notFound();
    if (r.status === "escuchando" && this.usesDeepgram(r)) {
      // El proceso anterior pudo terminar sin cerrar la captura.
      r.status = "pausada";
      r.pauseReason = "conexion";
      await this.persist(r);
    }
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
    const items = this.usesDeepgram(r) ? [] : extractDemo(r.segments, r.speakerRoles, r.template);
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
    const days = owner?.historyRetentionDays ?? null;
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
      transcription: this.usesDeepgram(r) ? "deepgram" : "demo",
      autoDeleteAt: days === null ? null : new Date(r.lastActivity + days * 86_400_000).toISOString(),
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

  /** ¿Esta sesión es la que escucha alguna entrevista? (exime solo a esa sesión de la inactividad) */
  isListeningSession(sessionId: string) {
    for (const [id, s] of this.listeners) {
      if (s.sessionId === sessionId && this.live.get(id)?.status === "escuchando") return true;
    }
    return false;
  }

  /** Sesiones que tienen una escucha activa (para revisarlas aunque no tengan canal abierto). */
  listeningSessions(): AuthSession[] {
    const out = new Map<string, AuthSession>();
    for (const [id, s] of this.listeners) if (this.live.get(id)?.status === "escuchando") out.set(s.sessionId, s);
    return [...out.values()];
  }

  /** Pausa solo las escuchas iniciadas o reanudadas por esta sesión. */
  async pauseForSession(sessionId: string, reason: string) {
    for (const [id, s] of [...this.listeners]) {
      if (s.sessionId !== sessionId) continue;
      const r = this.live.get(id);
      if (!r || r.status !== "escuchando") continue;
      this.applyCommand(r, "pausar", reason);
      await this.commit(r).catch((e) => logError("pause_session", e));
      this.releaseIfIdle(id);
    }
  }

  async consent(ownerId: string, id: string, givenBy: Consent["givenBy"]) {
    const r = await this.get(ownerId, id);
    this.requireEditable(r);
    if (givenBy !== "paciente" && givenBy !== "representante")
      throw new HttpError(400, "consentimiento_invalido", "Indica quién otorgó el consentimiento.");
    r.consent = { at: new Date().toISOString(), givenBy, ...(this.usesDeepgram(r) ? { transcription: "deepgram" } : {}) };
    await this.commit(r);
    logEvent("consent_recorded");
    return this.snapshot(r);
  }

  private usesDeepgram(r: InterviewRecord) {
    const src = this.sources.get(r.id);
    if (src) return src.kind === "deepgram";
    if (r.segments.length) return r.segments.some((segment) => segment.source === "deepgram");
    if (r.consent?.transcription === "deepgram") return true;
    if (!r.consent && (r.status === "detenida" || r.status === "finalizada")) return false; // borrador escrito offline
    return !!this.config.deepgram;
  }

  async command(
    ownerId: string, id: string, cmd: Command, reason: string | null = null,
    session?: AuthSession, capture?: AudioCapture, requestedCaptureId?: string,
  ) {
    const r = await this.get(ownerId, id);
    this.requireEditable(r);
    this.retain(r);
    try {
      const src = this.sources.get(id);
      const listening = this.listeners.get(id);
      if (src instanceof DeepgramSource && r.status === "escuchando" && listening?.sessionId !== session?.sessionId)
        throw new HttpError(409, "otra_sesion", "Los controles de escucha están en el dispositivo que activó el micrófono.");
      if (src instanceof DeepgramSource && reason === "segundo_plano" && src.capture.id !== requestedCaptureId)
        throw new HttpError(409, "captura_inactiva", "La interrupción corresponde a otra captura.");
      if (this.finishing.has(id))
        throw new HttpError(409, "cerrando_audio", "Espera a que termine de procesarse el audio.");

      if (this.usesDeepgram(r) && (cmd === "iniciar" || cmd === "reanudar")) {
        const validStatus = cmd === "iniciar" ? "preparada" : "pausada";
        if (r.status !== validStatus) throw new HttpError(409, "estado_invalido", "Esa acción no está disponible.");
        if (r.consent?.transcription !== "deepgram") throw new HttpError(403, "sin_consentimiento", "Registra el consentimiento antes de activar el micrófono.");
        if (!this.config.deepgram) throw new HttpError(503, "transcripcion_no_disponible", "La transcripción está desactivada.");
        if (!capture || !session) throw new HttpError(400, "captura_requerida", "Activa el micrófono para escuchar.");
        const offset = r.segments.reduce((max, seg) => Math.max(max, seg.end), 0);
        const speaker = r.segments.reduce((max, seg) => Math.max(max, seg.speaker + 1), 1);
        const source = new DeepgramSource(
          capture, this.config.deepgram.key,
          {
            onInterim: (sp, text) => this.emit(r.id, "interim", { speaker: sp, text }),
            onFinal: (seg) => this.appendSegment(r, { ...seg, source: "deepgram" }),
            onEnd: () => undefined,
          },
          offset, speaker,
          () => {
            if (this.sources.get(id) !== source || r.status !== "escuchando") return;
            this.applyCommand(r, "pausar", "transcripcion");
            void this.commit(r).catch((e) => logError("capture_pause", e)).finally(() => this.releaseIfIdle(id));
          },
          this.connectDeepgram,
        );
        this.sources.set(id, source);
        r.status = "escuchando";
        r.pauseReason = null;
        this.listeners.set(id, session);
        source.start();
      } else {
        let incomplete = false;
        if (src instanceof DeepgramSource && (cmd === "pausar" || cmd === "detener") && !reason && r.status === "escuchando") {
          this.finishing.add(id);
          try { incomplete = !(await src.finish()); }
          finally { this.finishing.delete(id); }
          // El cierre de sesión pudo suspender la captura mientras se vaciaba.
          if (r.status !== "escuchando" || !this.listeners.has(id)) return this.snapshot(r);
        }
        this.applyCommand(r, cmd, incomplete ? "audio_incompleto" : reason);
        if (incomplete) r.pauseReason = "audio_incompleto";
        if ((cmd === "iniciar" || cmd === "reanudar") && session && r.status === "escuchando") this.listeners.set(id, session);
      }
      await this.commit(r);
      return this.snapshot(r);
    } finally {
      this.releaseIfIdle(r.id);
    }
  }

  async acceptAudio(ownerId: string, interviewId: string, sessionId: string, captureId: string, sequence: number, pcm: Buffer) {
    const r = this.live.get(interviewId);
    if (!r || r.ownerId !== ownerId) throw notFound();
    const src = this.sources.get(interviewId);
    if (!(src instanceof DeepgramSource) || r.status !== "escuchando" || src.capture.id !== captureId ||
        this.listeners.get(interviewId)?.sessionId !== sessionId)
      throw new HttpError(409, "captura_inactiva", "No hay una captura activa para este dispositivo.");
    await src.send(sequence, pcm);
  }

  private appendSegment(r: InterviewRecord, segment: Omit<InterviewRecord["segments"][number], "id">) {
    r.segments.push({ ...segment, id: `s${r.segments.length + 1}` });
    r.speakerRoles[segment.speaker] ??= "sin_asignar";
    r.lastActivity = Date.now();
    this.persist(r).catch((e) => logError("segment_save", e));
    this.broadcast(r);
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
          onFinal: (seg) => this.appendSegment(r, seg),
          onEnd: () => {
            if (r.status === "escuchando" || r.status === "pausada") {
              r.status = "detenida";
              r.pauseReason = null;
              this.sources.delete(r.id);
              this.listeners.delete(r.id);
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
      this.listeners.delete(r.id);
      const src = this.sources.get(r.id);
      src?.pause();
      if (src instanceof DeepgramSource) this.sources.delete(r.id);
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
      this.listeners.delete(r.id);
      r.status = "detenida";
      r.pauseReason = null;
      const src = this.sources.get(r.id);
      this.sources.delete(r.id);
      src?.stop();
    }
    logEvent("interview_command", { cmd });
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
    this.listeners.delete(r.id);
    this.sources.get(r.id)?.stop();
    this.sources.delete(r.id);
    this.live.delete(r.id);
    await this.writes.get(r.id)?.catch(() => undefined);
    await this.store.deleteInterview(ownerId, id);
    this.closeSubscribers(id);
    logEvent("interview_deleted");
  }

  // ---- Borradores escritos sin conexión ----

  /** Devuelve el registro en memoria si hay una pantalla abierta. */
  liveRecord(id: string) {
    return this.live.get(id);
  }

  /** Publica la revisión después de confirmar la transacción de sincronización. */
  publishOfflineUpdate(r: InterviewRecord, shouldRefresh: (live: InterviewRecord) => boolean) {
    const live = this.live.get(r.id);
    if (!live || !shouldRefresh(live)) return;
    Object.assign(live, r);
    this.broadcast(live);
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
