import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    /** Mensaje para la persona usuaria; nunca contiene datos clínicos. */
    public userMessage: string,
  ) {
    super(code);
    this.name = "HttpError";
  }
}

export const MAX_JSON_BYTES = 64 * 1024;

export async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "muy_grande", "El archivo supera el tamaño máximo (5 MB).");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "muy_grande", "El archivo supera el tamaño máximo (5 MB).");
    chunks.push(c as Buffer);
  }
  if (!size) throw new HttpError(400, "vacio", "El archivo está vacío.");
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json"))
    throw new HttpError(415, "tipo_no_soportado", "Se esperaba JSON.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "muy_grande", "La solicitud es demasiado grande.");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("no-object");
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "json_invalido", "La solicitud no es JSON válido.");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        /* cookie mal formada: se ignora */
      }
    }
  }
  return out;
}

export function securityHeaders(res: ServerResponse, https: boolean) {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
      "font-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; " +
      "frame-ancestors 'none'; object-src 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
  if (https) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}
