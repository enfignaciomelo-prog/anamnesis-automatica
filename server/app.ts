/**
 * Servidor HTTP: API, eventos en vivo (SSE) y la interfaz compilada.
 * Sin dependencias externas: módulo `node:http` de Node.js.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { SessionInfo, SpeakerRole } from "../shared/types";
import type { Config } from "./config";
import { exportDocx, exportPdf, exportText } from "./export/exporters";
import { HttpError, parseCookies, readJson, readRaw, securityHeaders, sendJson } from "./http";
import { type Command, InterviewService } from "./interviews";
import { logError, logRequest } from "./log";
import { MemoryStore, type Store } from "./store";
import { MAX_UPLOAD_BYTES } from "./templates/safety";
import { TemplateService } from "./templates/service";

const SESSION_COOKIE = "aa_sid";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export const DEMO_PROFESSIONALS = {
  "demo-a": "Profesional Demo A (ficticio)",
  "demo-b": "Profesional Demo B (ficticio)",
} as const;

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

export interface App {
  server: Server;
  service: InterviewService;
  templates: TemplateService;
  store: Store;
  close(): Promise<void>;
}

export function createApp(config: Config): App {
  const store = new MemoryStore();
  const service = new InterviewService(store, config);
  const templates = new TemplateService(store);
  const fileInUse = (ownerId: string) => (fileId: string) =>
    store.listInterviews(ownerId).some((r) => r.template.source?.fileId === fileId);
  const staticRoot = resolve(config.staticDir);

  const isHttps = (req: IncomingMessage) =>
    (config.trustProxy && req.headers["x-forwarded-proto"] === "https") ||
    Boolean((req.socket as { encrypted?: boolean }).encrypted);

  function session(ctx: Ctx) {
    const sid = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
    const s = sid ? store.getSession(sid) : undefined;
    const p = s ? store.getProfessional(s.professionalId) : undefined;
    return s && p ? { session: s, professional: p } : undefined;
  }

  function requireAuth(ctx: Ctx) {
    const s = session(ctx);
    if (!s) throw new HttpError(401, "sin_sesion", "Inicia sesión para continuar.");
    return s.professional;
  }

  function sessionInfo(p: { id: string; name: string; retentionMinutes: number }): SessionInfo {
    return {
      professional: { id: p.id, name: p.name },
      demo: config.demo,
      retentionMinutes: p.retentionMinutes,
      retentionOptions: config.retentionOptions,
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

  async function api(ctx: Ctx): Promise<void> {
    const { req, res, url } = ctx;
    const m = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    if (m !== "GET" && m !== "HEAD") checkOrigin(ctx);

    if (parts[1] === "health" && m === "GET") {
      ctx.route = "/api/health";
      return sendJson(res, 200, { ok: true, demo: config.demo });
    }

    if (parts[1] === "demo" && parts[2] === "session" && m === "POST") {
      ctx.route = "/api/demo/session";
      const body = await readJson(req);
      const perfil = body.perfil as keyof typeof DEMO_PROFESSIONALS;
      if (!config.demo || !(perfil in DEMO_PROFESSIONALS))
        throw new HttpError(400, "perfil_invalido", "Perfil de demostración no válido.");
      const existing = store.getProfessional(perfil);
      if (!existing)
        store.upsertProfessional({
          id: perfil,
          name: DEMO_PROFESSIONALS[perfil],
          retentionMinutes: config.retentionDefaultMinutes,
        });
      const s = store.createSession(perfil, SESSION_TTL_MS);
      res.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${ctx.https ? "; Secure" : ""}`,
      );
      return sendJson(res, 200, sessionInfo(store.getProfessional(perfil)!));
    }

    if (parts[1] === "session" && m === "GET") {
      ctx.route = "/api/session";
      const s = session(ctx);
      if (!s) throw new HttpError(401, "sin_sesion", "Inicia sesión para continuar.");
      return sendJson(res, 200, sessionInfo(s.professional));
    }

    if (parts[1] === "logout" && m === "POST") {
      ctx.route = "/api/logout";
      const s = session(ctx);
      if (s) store.deleteSession(s.session.id);
      res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return sendJson(res, 200, { ok: true });
    }

    if (parts[1] === "settings" && m === "PATCH") {
      ctx.route = "/api/settings";
      const p = requireAuth(ctx);
      const body = await readJson(req);
      const minutes = Number(body.retentionMinutes);
      if (!config.retentionOptions.includes(minutes))
        throw new HttpError(400, "retencion_invalida", "Plazo de retención no válido.");
      p.retentionMinutes = minutes;
      store.upsertProfessional(p);
      return sendJson(res, 200, sessionInfo(p));
    }

    if (parts[1] === "templates") {
      const p = requireAuth(ctx);
      const id = parts[2];
      if (!id) {
        ctx.route = "/api/templates";
        if (m === "GET") return sendJson(res, 200, templates.list(p.id));
        if (m === "POST") {
          const body = await readJson(req, 256 * 1024);
          const fromId = typeof body.fromId === "string" ? body.fromId : undefined;
          return sendJson(res, 201, templates.create(p.id, body, fromId));
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
          return sendJson(res, 200, templates.detail(p.id, id, Number.isInteger(v) && v > 0 ? v : undefined));
        }
        if (m === "PUT") return sendJson(res, 200, await templates.update(p.id, id, await readJson(req, 256 * 1024)));
        if (m === "DELETE") {
          templates.delete(p.id, id, fileInUse(p.id));
          return sendJson(res, 200, { ok: true });
        }
      }
    }

    if (parts[1] === "interviews") {
      const p = requireAuth(ctx);
      const id = parts[2];
      if (!id) {
        ctx.route = "/api/interviews";
        if (m === "GET") return sendJson(res, 200, service.list(p.id));
        if (m === "POST") {
          const body = await readJson(req);
          const template = templates.resolve(p.id, typeof body.templateId === "string" ? body.templateId : undefined);
          return sendJson(res, 201, service.read(p.id, service.create(p.id, template).id));
        }
      } else {
        const sub = parts[3];
        ctx.route = `/api/interviews/:id${sub ? `/${sub}` : ""}${parts[4] ? "/:field" : ""}${parts[5] ? `/${parts[5]}` : ""}`;
        if (!sub && m === "GET") return sendJson(res, 200, service.read(p.id, id));
        if (!sub && m === "DELETE") {
          service.delete(p.id, id);
          return sendJson(res, 200, { ok: true });
        }
        if (sub === "events" && m === "GET") {
          service.record(p.id, id); // verifica el dueño antes de abrir el canal
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          res.write("retry: 2000\n\n");
          service.subscribe(p.id, id, res);
          return;
        }
        if (m === "POST") {
          const body = await readJson(req);
          if (sub === "consent")
            return sendJson(res, 200, service.consent(p.id, id, body.givenBy as "paciente"));
          if (sub === "command") {
            const cmd = body.command as Command;
            if (!["iniciar", "pausar", "reanudar", "detener"].includes(cmd))
              throw new HttpError(400, "comando_invalido", "Acción no válida.");
            const reason = typeof body.reason === "string" && /^[a-z_-]{1,30}$/.test(body.reason) ? body.reason : null;
            return sendJson(res, 200, service.command(p.id, id, cmd, reason));
          }
          if (sub === "speakers")
            return sendJson(
              res,
              200,
              service.setRole(p.id, id, Number(body.speaker), body.role as SpeakerRole),
            );
          if (sub === "fields" && parts[4] && parts[5] === "confirm") {
            const value = typeof body.value === "string" ? body.value : null;
            return sendJson(res, 200, service.confirmField(p.id, id, parts[4], value));
          }
          if (sub === "fields" && parts[4] && parts[5] === "no-referido")
            return sendJson(res, 200, service.markNotReported(p.id, id, parts[4]));
          if (sub === "finalize")
            return sendJson(res, 200, service.finalize(p.id, id, body.attested === true));
        }
        if (sub === "export" && m === "GET") {
          const snap = service.read(p.id, id);
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
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      ...(rel === "sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
    });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  }

  const server = createServer(async (req, res) => {
    const t0 = performance.now();
    const ctx: Ctx = {
      req,
      res,
      url: new URL(req.url ?? "/", "http://local"),
      https: false,
      route: "?",
    };
    ctx.https = isHttps(req);
    securityHeaders(res, ctx.https);
    res.on("finish", () => logRequest(req.method ?? "?", ctx.route, res.statusCode, performance.now() - t0));
    try {
      if (ctx.url.pathname.startsWith("/api/")) await api(ctx);
      else serveStatic(ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { error: err.code, message: err.userMessage });
        else res.end();
      } else {
        logError(ctx.route, err);
        if (!res.headersSent) sendJson(res, 500, { error: "interno", message: "Ocurrió un error interno." });
        else res.end();
      }
    }
  });

  const sweepTimer = setInterval(() => service.sweep(), 30_000);
  const beatTimer = setInterval(() => service.heartbeat(), 15_000);
  sweepTimer.unref();
  beatTimer.unref();

  return {
    server,
    service,
    store,
    templates,
    close: () =>
      new Promise<void>((done) => {
        clearInterval(sweepTimer);
        clearInterval(beatTimer);
        service.shutdown();
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
