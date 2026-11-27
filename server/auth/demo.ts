/**
 * Modo demostración: dos perfiles ficticios sin contraseña. Solo para probar la
 * aplicación con datos ficticios; nunca se activa con DEMO_MODE=false.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, parseCookies, readJson, sendJson } from "../http";
import type { AuthGate, AuthSession } from "./types";

export const DEMO_PROFESSIONALS = {
  "demo-a": "Profesional Demo A (ficticio)",
  "demo-b": "Profesional Demo B (ficticio)",
} as const;

const COOKIE = "aa_sid";
const TTL_MS = 24 * 60 * 60 * 1000;

export class DemoAuth implements AuthGate {
  readonly mode = "demo" as const;
  private sessions = new Map<string, { id: string; userId: string; createdAt: number; expiresAt: number }>();

  constructor(
    private onLogin: (userId: string, name: string) => Promise<void>,
    private now: () => number = () => Date.now(),
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, https: boolean) {
    if (url.pathname !== "/api/demo/session" || req.method !== "POST") return false;
    const body = await readJson(req);
    const perfil = body.perfil as keyof typeof DEMO_PROFESSIONALS;
    if (!(perfil in DEMO_PROFESSIONALS)) throw new HttpError(400, "perfil_invalido", "Perfil de demostración no válido.");
    await this.onLogin(perfil, DEMO_PROFESSIONALS[perfil]);
    const now = this.now();
    const s = { id: randomBytes(32).toString("base64url"), userId: perfil, createdAt: now, expiresAt: now + TTL_MS };
    this.sessions.set(s.id, s);
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_MS / 1000}${https ? "; Secure" : ""}`,
    );
    sendJson(res, 200, { ok: true });
    return true;
  }

  async getSession(req: IncomingMessage): Promise<AuthSession | null> {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    const s = sid ? this.sessions.get(sid) : undefined;
    if (!s) return null;
    if (s.expiresAt < this.now()) {
      this.sessions.delete(s.id);
      return null;
    }
    const userId = s.userId as keyof typeof DEMO_PROFESSIONALS;
    return { sessionId: s.id, user: { id: userId, name: DEMO_PROFESSIONALS[userId] }, createdAt: s.createdAt };
  }

  async isActive(sessionId: string) {
    const s = this.sessions.get(sessionId);
    return Boolean(s && s.expiresAt >= this.now());
  }

  /** Solo pruebas: retrocede el inicio de una sesión para simular el paso del tiempo. */
  shiftSession(sessionId: string, ms: number) {
    const s = this.sessions.get(sessionId);
    if (s) s.createdAt += ms;
  }

  async revoke(session: AuthSession) {
    this.sessions.delete(session.sessionId);
  }

  clearCookies(https: boolean) {
    return [`${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${https ? "; Secure" : ""}`];
  }

  async close() {}
}
