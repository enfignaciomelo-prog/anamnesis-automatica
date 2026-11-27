/**
 * Servidor HTTP: API, eventos en vivo (SSE) y la interfaz compilada.
 * Módulo `node:http` de Node.js; las cuentas usan Better Auth (modo cuentas).
 *
 * Reglas de sesión (todas en el servidor, sin depender del reloj del equipo):
 * - La identidad se obtiene SIEMPRE de la sesión autenticada.
 * - Corte diario: la sesión vence a las 23:59:00 America/Santiago del día en
 *   que se inició; el siguiente acceso válido pertenece al período siguiente.
 * - Bloqueo por inactividad configurable por profesional.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { nextDailyCutoff, zonedTimeToUtc } from "../shared/cutoff";
import type { SessionInfo, SpeakerRole } from "../shared/types";
import { DemoAuth } from "./auth/demo";
import type { AuthGate, AuthSession } from "./auth/types";
import type { Config } from "./config";
import { exportDocx, exportPdf, exportText } from "./export/exporters";
import { HttpError, readJson, readRaw, securityHeaders, sendJson } from "./http";
import { type Command, InterviewService } from "./interviews";
import { logError, logEvent, logRequest } from "./log";
import { OfflineSyncService, parseSyncRequest } from "./offline";
import { type InterviewFilter, MemoryStore, type Professional, type Store } from "./store";
import { MAX_UPLOAD_BYTES } from "./templates/safety";
import { TemplateService } from "./templates/service";

export { DEMO_PROFESSIONALS } from "./auth/demo";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  https: boolean;
  route: string;
}

interface Authed {
  session: AuthSession;
  professional: Professional;
  cutoffAt: number;
  idleUntil: number;
}

export interface App {
  server: Server;
  service: InterviewService;
  templates: TemplateService;
  store: Store;
  gate: AuthGate;
  close(): Promise<void>;
}

export interface AppDeps {
  store?: Store;
  gate?: AuthGate;
  /** Reloj inyectable (solo pruebas). */
  now?: () => number;
}

export function createApp(config: Config, deps: AppDeps = {}): App {
  const store = deps.store ?? new MemoryStore();
  let testOffset = 0;
  const now = deps.now ?? (() => Date.now() + testOffset);
  const ensureProfessional = async (id: string, name: string) => {
    const p = await store.getProfessional(id);
    if (!p)
      await store.upsertProfessional({
        id,
        name,
        historyRetentionDays: null, // sin eliminación automática salvo configuración explícita
        idleMinutes: config.idleDefaultMinutes,
      });
  };
  const gate = deps.gate ?? new DemoAuth(ensureProfessional, now);
  const service = new InterviewService(store, config);

  // ---- Canales en vivo ligados a su sesión ----
  // El servidor los cierra por sí mismo al llegar el corte, al revocarse la
  // sesión por otra vía o por inactividad, sin esperar otra petición.
  interface SessionStreams {
    session: AuthSession;
    cutoffAt: number;
    streams: Set<{ res: ServerResponse; interviewId: string }>;
    timer: NodeJS.Timeout;
  }
  const liveSessions = new Map<string, SessionStreams>();

  function closeSessionStreams(sessionId: string, reason: string) {
    const entry = liveSessions.get(sessionId);
    if (!entry) return [] as string[];
    clearTimeout(entry.timer);
    liveSessions.delete(sessionId);
    const ids: string[] = [];
    for (const { res, interviewId } of entry.streams) {
      ids.push(interviewId);
      if (!res.writableEnded) {
        res.write(`event: session_ended\ndata: ${JSON.stringify({ reason })}\n\n`);
        res.end();
      }
    }
    logEvent("streams_closed", { reason, count: ids.length });
    return ids;
  }

  /** Termina una sesión desde el servidor: revoca, pausa lo que escuchaba y cierra sus canales. */
  async function expireSession(s: AuthSession, reason: string) {
    closeSessionStreams(s.sessionId, reason);
    await gate.revoke(s).catch((e) => logError("revoke", e));
    await store.deleteActivity(s.sessionId).catch(() => undefined);
    // Solo se pausa lo que escuchaba ESTA sesión; una sesión observadora no detiene
    // la escucha iniciada en otro dispositivo.
    await service.pauseForSession(s.sessionId, reason);
  }

  function registerStream(a: { session: AuthSession; cutoffAt: number }, interviewId: string, res: ServerResponse) {
    let entry = liveSessions.get(a.session.sessionId);
    if (!entry) {
      const delay = Math.max(0, Math.min(a.cutoffAt - now(), 2 ** 31 - 1));
      entry = {
        session: a.session,
        cutoffAt: a.cutoffAt,
        streams: new Set(),
        timer: setTimeout(() => void expireSession(a.session, "corte_diario"), delay),
      };
      liveSessions.set(a.session.sessionId, entry);
    }
    const item = { res, interviewId };
    entry.streams.add(item);
    res.on("close", () => {
      const e = liveSessions.get(a.session.sessionId);
      if (!e) return;
      e.streams.delete(item);
      if (e.streams.size === 0) {
        clearTimeout(e.timer);
        liveSessions.delete(a.session.sessionId);
      }
    });
  }

  /**
   * Revisión periódica de sesiones con canales abiertos o con una escucha activa
   * (aunque no tengan pantalla conectada).
   */
  async function checkLiveSessions() {
    const t = now();
    const sessions = new Map<string, { session: AuthSession; cutoffAt: number }>();
    for (const e of liveSessions.values()) sessions.set(e.session.sessionId, { session: e.session, cutoffAt: e.cutoffAt });
    for (const ls of service.listeningSessions())
      if (!sessions.has(ls.sessionId)) sessions.set(ls.sessionId, { session: ls, cutoffAt: nextDailyCutoff(ls.createdAt) });
    for (const { session: s, cutoffAt } of sessions.values()) {
      try {
        if (t >= cutoffAt) {
          await expireSession(s, "corte_diario");
          continue;
        }
        if (!(await gate.isActive(s.sessionId))) {
          // Revocada por otra vía (cierre en otro lugar, cambio de contraseña…).
          closeSessionStreams(s.sessionId, "revocada");
          await service.pauseForSession(s.sessionId, "revocada");
          continue;
        }
        // Inactividad por sesión: solo se exime la sesión que está escuchando.
        if (!service.isListeningSession(s.sessionId)) {
          const p = await store.getProfessional(s.user.id);
          const last = (await store.getActivity(s.sessionId)) ?? s.createdAt;
          if (p && t - last > p.idleMinutes * 60_000) await expireSession(s, "inactividad");
        }
      } catch (e) {
        logError("check_sessions", e);
      }
    }
  }

  const templates = new TemplateService(store);
  const offline = new OfflineSyncService(store, service, templates);
  const staticRoot = resolve(config.staticDir);

  const isHttps = (req: IncomingMessage) =>
    (config.trustProxy && req.headers["x-forwarded-proto"] === "https") ||
    Boolean((req.socket as { encrypted?: boolean }).encrypted);

  async function endSession(ctx: Ctx, s: AuthSession, reason: string) {
    // Solo esta sesión: otros dispositivos del mismo profesional siguen abiertos.
    await expireSession(s, reason);
    ctx.res.setHeader("Set-Cookie", gate.clearCookies(ctx.https));
    // El navegador borra la caché HTTP del sitio. No se usa "storage": borraría los
    // borradores cifrados sin conexión, que se conservan hasta el corte diario.
    // El resto del almacenamiento lo limpia la interfaz (web/session.ts).
    ctx.res.setHeader("Clear-Site-Data", '"cache"');
    logEvent("session_ended", { reason });
  }

  /**
   * Autentica y hace cumplir el corte diario y la inactividad.
   * `touch=false` para consultas de estado que no cuentan como actividad.
   */
  async function requireAuth(ctx: Ctx, touch = true): Promise<Authed> {
    const s = await gate.getSession(ctx.req);
    if (!s) throw new HttpError(401, "sin_sesion", "Inicia sesión para continuar.");
    const t = now();
    const cutoffAt = nextDailyCutoff(s.createdAt);
    if (t >= cutoffAt) {
      await endSession(ctx, s, "corte_diario");
      throw new HttpError(401, "sesion_vencida", "La sesión venció en el corte diario de las 23:59. Inicia sesión de nuevo.");
    }
    await ensureProfessional(s.user.id, s.user.name);
    const professional = (await store.getProfessional(s.user.id))!;
    const last = (await store.getActivity(s.sessionId)) ?? s.createdAt;
    const idleMs = professional.idleMinutes * 60_000;
    // Mientras escucha una entrevista, el profesional está activo aunque no toque la pantalla.
    // Exención por inactividad SOLO para la sesión que escucha, no para la cuenta.
    const listening = service.isListeningSession(s.sessionId);
    if (!listening && t - last > idleMs) {
      await endSession(ctx, s, "inactividad");
      throw new HttpError(401, "bloqueo_inactividad", "La sesión se bloqueó por inactividad. Inicia sesión de nuevo.");
    }
    if (touch || listening) await store.touchActivity(s.sessionId, t);
    const lastSeen = touch || listening ? t : last;
    return { session: s, professional, cutoffAt, idleUntil: lastSeen + idleMs };
  }

  function sessionInfo(a: Authed): SessionInfo {
    return {
      professional: { id: a.professional.id, name: a.session.user.name, email: a.session.user.email },
      demo: config.demo,
      authMode: gate.mode,
      historyRetentionDays: a.professional.historyRetentionDays,
      historyRetentionOptions: config.historyRetentionOptions,
      idleMinutes: a.professional.idleMinutes,
      idleOptions: config.idleOptions,
      cutoffAt: new Date(a.cutoffAt).toISOString(),
      expiresAt: new Date(Math.min(a.cutoffAt, a.idleUntil)).toISOString(),
      serverTime: new Date(now()).toISOString(),
    };
  }

  function checkOrigin(ctx: Ctx) {
    const origin = ctx.req.headers.origin;
    if (!origin) return;
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, "origen", "Origen no permitido.");
    }
    if (host !== ctx.req.headers.host) throw new HttpError(403, "origen", "Origen no permitido.");
  }

  function parseFilter(url: URL): InterviewFilter {
    const f: InterviewFilter = {};
    const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v.split("-").map(Number) : null);
    const d1 = day(url.searchParams.get("desde"));
    const d2 = day(url.searchParams.get("hasta"));
    // Fechas interpretadas en la hora de Chile.
    if (d1) f.from = zonedTimeToUtc(d1[0], d1[1], d1[2], 0, 0, 0);
    if (d2) f.to = zonedTimeToUtc(d2[0], d2[1], d2[2], 23, 59, 59) + 999;
    const estado = url.searchParams.get("estado");
    if (estado === "borrador" || estado === "revisada") f.state = estado;
    return f;
  }

  async function api(ctx: Ctx): Promise<void> {
    const { req, res, url } = ctx;
    const m = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    if (m !== "GET" && m !== "HEAD") checkOrigin(ctx);

    if (parts[1] === "health" && m === "GET") {
      ctx.route = "/api/health";
      return sendJson(res, 200, { ok: true, demo: config.demo, auth: gate.mode, store: store.kind });
    }

    ctx.route = parts[1] === "auth" ? "/api/auth/*" : url.pathname.startsWith("/api/dev/") ? "/api/dev/*" : ctx.route;
    if (await gate.handle(req, res, url, ctx.https)) {
      if (ctx.route === "?") ctx.route = "/api/demo/session";
      return;
    }

    // Reloj de prueba (solo E2E en modo demo, nunca en producción).
    if (parts[1] === "dev" && parts[2] === "clock" && m === "POST" && config.testClock) {
      ctx.route = "/api/dev/clock";
      const body = await readJson(req);
      const target = Number(body.secondsBeforeCutoff);
      const s = await gate.getSession(req);
      if (!s || !Number.isFinite(target)) throw new HttpError(400, "reloj", "Parámetros no válidos.");
      testOffset = nextDailyCutoff(s.createdAt) - target * 1000 - Date.now();
      // Simula una sesión que estuvo activa hasta ese momento (no prueba la inactividad).
      await store.touchActivity(s.sessionId, now());
      return sendJson(res, 200, { ok: true });
    }

    if (parts[1] === "session" && m === "GET") {
      ctx.route = "/api/session";
      // Consultar el estado no cuenta como actividad.
      return sendJson(res, 200, sessionInfo(await requireAuth(ctx, false)));
    }

    if (parts[1] === "logout" && m === "POST") {
      ctx.route = "/api/logout";
      const s = await gate.getSession(req);
      if (s) await endSession(ctx, s, "manual");
      else res.setHeader("Set-Cookie", gate.clearCookies(ctx.https));
      return sendJson(res, 200, { ok: true });
    }

    if (parts[1] === "settings" && m === "PATCH") {
      ctx.route = "/api/settings";
      const a = await requireAuth(ctx);
      const body = await readJson(req);
      const p = { ...a.professional };
      if (body.historyRetentionDays !== undefined) {
        // Activar la eliminación del historial requiere una confirmación explícita.
        if (body.historyRetentionDays === null) p.historyRetentionDays = null;
        else {
          const v = Number(body.historyRetentionDays);
          if (!config.historyRetentionOptions.includes(v))
            throw new HttpError(400, "retencion_invalida", "Plazo de eliminación no válido.");
          if (body.confirmHistoryDeletion !== true)
            throw new HttpError(400, "confirmacion_requerida", "Confirma explícitamente la eliminación automática del historial.");
          p.historyRetentionDays = v;
        }
      }
      if (body.idleMinutes !== undefined) {
        const v = Number(body.idleMinutes);
        if (!config.idleOptions.includes(v)) throw new HttpError(400, "inactividad_invalida", "Tiempo de bloqueo no válido.");
        p.idleMinutes = v;
      }
      await store.upsertProfessional(p);
      return sendJson(res, 200, sessionInfo({ ...a, professional: p, idleUntil: now() + p.idleMinutes * 60_000 }));
    }

    // Modo sin conexión manual: paquete para preparar el dispositivo y sincronización idempotente.
    if (parts[1] === "offline") {
      const a = await requireAuth(ctx);
      if (parts[2] === "package" && m === "GET") {
        ctx.route = "/api/offline/package";
        return sendJson(
          res,
          200,
          await offline.package({ id: a.professional.id, name: a.session.user.name }, a.cutoffAt, now()),
        );
      }
      if (parts[2] === "sync" && m === "POST") {
        ctx.route = "/api/offline/sync";
        const body = await readJson(req, 512 * 1024);
        return sendJson(res, 200, await offline.sync(a.professional.id, parseSyncRequest(body)));
      }
    }

    if (parts[1] === "templates") {
      const { professional: p } = await requireAuth(ctx);
      const id = parts[2];
      if (!id) {
        ctx.route = "/api/templates";
        if (m === "GET") return sendJson(res, 200, await templates.list(p.id));
        if (m === "POST") {
          const body = await readJson(req, 256 * 1024);
          const fromId = typeof body.fromId === "string" ? body.fromId : undefined;
          return sendJson(res, 201, await templates.create(p.id, body, fromId));
        }
      } else if (id === "import") {
        if (!parts[3] && m === "POST") {
          ctx.route = "/api/templates/import";
          let name = "";
          try {
            name = decodeURIComponent(String(req.headers["x-file-name"] ?? ""));
          } catch {
            name = "";
          }
          const bytes = await readRaw(req, MAX_UPLOAD_BYTES);
          return sendJson(res, 200, await templates.analyze(p.id, name, bytes, config.ocr));
        }
        if (parts[3] && parts[4] === "confirm" && m === "POST") {
          ctx.route = "/api/templates/import/:id/confirm";
          const body = await readJson(req, 256 * 1024);
          return sendJson(res, 201, await templates.confirmImport(p.id, parts[3], body));
        }
      } else {
        ctx.route = "/api/templates/:id";
        if (m === "GET") {
          const v = Number(url.searchParams.get("version"));
          return sendJson(res, 200, await templates.detail(p.id, id, Number.isInteger(v) && v > 0 ? v : undefined));
        }
        if (m === "PUT") return sendJson(res, 200, await templates.update(p.id, id, await readJson(req, 256 * 1024)));
        if (m === "DELETE") {
          await templates.delete(p.id, id);
          return sendJson(res, 200, { ok: true });
        }
      }
    }

    if (parts[1] === "interviews") {
      const authed = await requireAuth(ctx);
      const p = authed.professional;
      const id = parts[2];
      if (!id) {
        ctx.route = "/api/interviews";
        if (m === "GET") return sendJson(res, 200, await service.list(p.id, parseFilter(url)));
        if (m === "POST") {
          const body = await readJson(req);
          const template = await templates.resolve(p.id, typeof body.templateId === "string" ? body.templateId : undefined);
          const rec = await service.create(p.id, template);
          return sendJson(res, 201, await service.read(p.id, rec.id));
        }
      } else {
        const sub = parts[3];
        ctx.route = `/api/interviews/:id${sub ? `/${sub}` : ""}${parts[4] ? "/:field" : ""}${parts[5] ? `/${parts[5]}` : ""}`;
        if (!sub && m === "GET") return sendJson(res, 200, await service.read(p.id, id));
        if (!sub && m === "DELETE") {
          await service.delete(p.id, id);
          return sendJson(res, 200, { ok: true });
        }
        if (sub === "events" && m === "GET") {
          await service.read(p.id, id); // verifica el dueño antes de abrir el canal
          registerStream(authed, id, res);
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          res.write("retry: 2000\n\n");
          await service.subscribe(p.id, id, res);
          return;
        }
        if (m === "POST") {
          const body = await readJson(req);
          if (sub === "consent") return sendJson(res, 200, await service.consent(p.id, id, body.givenBy as "paciente"));
          if (sub === "command") {
            const cmd = body.command as Command;
            if (!["iniciar", "pausar", "reanudar", "detener"].includes(cmd))
              throw new HttpError(400, "comando_invalido", "Acción no válida.");
            const reason = typeof body.reason === "string" && /^[a-z_-]{1,30}$/.test(body.reason) ? body.reason : null;
            return sendJson(res, 200, await service.command(p.id, id, cmd, reason, authed.session));
          }
          if (sub === "speakers")
            return sendJson(res, 200, await service.setRole(p.id, id, Number(body.speaker), body.role as SpeakerRole));
          if (sub === "fields" && parts[4] && parts[5] === "confirm") {
            const value = typeof body.value === "string" ? body.value : null;
            return sendJson(res, 200, await service.confirmField(p.id, id, parts[4], value));
          }
          if (sub === "fields" && parts[4] && parts[5] === "draft") {
            if (typeof body.value !== "string") throw new HttpError(400, "texto_invalido", "Falta el texto.");
            return sendJson(res, 200, await service.saveDraft(p.id, id, parts[4], body.value));
          }
          if (sub === "fields" && parts[4] && parts[5] === "no-referido")
            return sendJson(res, 200, await service.markNotReported(p.id, id, parts[4]));
          if (sub === "finalize") return sendJson(res, 200, await service.finalize(p.id, id, body.attested === true));
        }
        if (sub === "export" && m === "GET") {
          const snap = await service.read(p.id, id);
          if (snap.status !== "finalizada")
            throw new HttpError(409, "no_finalizada", "Finaliza la revisión antes de exportar.");
          const opts = { includeEvidence: url.searchParams.get("respaldo") === "1", professionalName: p.name };
          const format = url.searchParams.get("format");
          const base = `anamnesis-${snap.demo ? "demo-" : ""}${snap.createdAt.slice(0, 10)}${format === "original" ? "-formato-original" : ""}`;
          let body: Buffer;
          let type: string;
          let ext: string;
          if (format === "txt") {
            body = Buffer.from(exportText(snap, opts), "utf8");
            type = "text/plain; charset=utf-8";
            ext = "txt";
          } else if (format === "docx") {
            body = await exportDocx(snap, opts);
            type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            ext = "docx";
          } else if (format === "pdf") {
            body = await exportPdf(snap, opts);
            type = "application/pdf";
            ext = "pdf";
          } else if (format === "original") {
            const out = await templates.exportOriginal(p.id, snap);
            body = out.bytes;
            ext = out.kind;
            type =
              out.kind === "xlsx"
                ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          } else throw new HttpError(400, "formato_invalido", "Formato no disponible.");
          res.writeHead(200, {
            "Content-Type": type,
            "Content-Disposition": `attachment; filename="${base}.${ext}"`,
            "Cache-Control": "no-store",
            "Content-Length": body.length,
          });
          res.end(body);
          return;
        }
      }
    }
    ctx.route = "/api/*";
    throw new HttpError(404, "ruta", "Recurso no encontrado.");
  }

  function serveStatic(ctx: Ctx) {
    const { req, res, url } = ctx;
    ctx.route = "static";
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = join(staticRoot, rel);
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(rel)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("No encontrado");
        return;
      }
      file = join(staticRoot, "index.html"); // rutas de la aplicación
    }
    if (!existsSync(file)) {
      res
        .writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
        .end("La interfaz no está compilada. Ejecuta la compilación (npm run build).");
      return;
    }
    const ext = extname(file);
    const immutable = rel.startsWith("assets/");
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      // index.html sin caché: evita que «Atrás» restaure páginas guardadas.
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : ext === ".html" ? "no-store" : "no-cache",
      ...(rel === "sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
    });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  }

  const server = createServer(async (req, res) => {
    const t0 = performance.now();
    const ctx: Ctx = { req, res, url: new URL(req.url ?? "/", "http://local"), https: false, route: "?" };
    ctx.https = isHttps(req);
    securityHeaders(res, ctx.https);
    res.on("finish", () => logRequest(req.method ?? "?", ctx.route, res.statusCode, performance.now() - t0));
    try {
      if (ctx.url.pathname.startsWith("/api/")) await api(ctx);
      else serveStatic(ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { ...err.extra, error: err.code, message: err.userMessage });
        else res.end();
      } else {
        logError(ctx.route, err);
        if (!res.headersSent) sendJson(res, 500, { error: "interno", message: "Ocurrió un error interno." });
        else res.end();
      }
    }
  });

  const sweepTimer = setInterval(() => service.sweep().catch((e) => logError("sweep", e)), 60_000);
  const sessionTimer = setInterval(() => void checkLiveSessions(), config.sessionCheckMs);
  sessionTimer.unref();
  const beatTimer = setInterval(() => service.heartbeat(), 15_000);
  sweepTimer.unref();
  beatTimer.unref();

  return {
    server,
    service,
    store,
    templates,
    gate,
    close: async () => {
      clearInterval(sweepTimer);
      clearInterval(beatTimer);
      clearInterval(sessionTimer);
      for (const id of [...liveSessions.keys()]) closeSessionStreams(id, "apagado");
      await service.shutdown();
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
      await gate.close();
      await store.close();
    },
  };
}
