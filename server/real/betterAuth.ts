/**
 * Cuentas con Better Auth (biblioteca mantenida; no se implementa criptografía
 * propia). Correo y contraseña con verificación obligatoria y restablecimiento.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import type pg from "pg";
import type { Config } from "../config";
import { type Mailer, resetMail, verificationMail } from "../auth/mailer";
import type { AuthGate, AuthSession } from "../auth/types";
import { sendJson } from "../http";

export const COOKIE_PREFIX = "aa";

export function createBetterAuth(pool: pg.Pool, config: Config, mailer: Mailer) {
  const baseUrl = config.auth!.baseUrl;
  const secure = baseUrl.startsWith("https://");
  return betterAuth({
    database: pool,
    secret: config.auth!.secret,
    baseURL: baseUrl,
    basePath: "/api/auth",
    trustedOrigins: [baseUrl],
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 3600,
      sendResetPassword: async ({ user, url }) => {
        await mailer.send(resetMail(user.email, url));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) => {
        await mailer.send(verificationMail(user.email, url));
      },
    },
    session: {
      // El corte diario lo hace cumplir la aplicación; esto es un tope adicional.
      expiresIn: 60 * 60 * 24,
      updateAge: 60 * 60,
    },
    // Producción: límites estrictos de Better Auth para ingreso y registro.
    // Fuera de producción (pruebas automáticas) se amplían para no bloquear la CI.
    rateLimit: config.production
      ? { enabled: true, window: 60, max: 30 }
      : {
          enabled: true,
          window: 60,
          max: 1000,
          customRules: {
            "/sign-in/email": { window: 10, max: 100 },
            "/sign-up/email": { window: 10, max: 100 },
            "/request-password-reset": { window: 10, max: 100 },
          },
        },
    advanced: {
      useSecureCookies: secure,
      cookiePrefix: COOKIE_PREFIX,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure },
    },
  });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;

export async function runAuthMigrations(auth: BetterAuthInstance) {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

export class BetterAuthGate implements AuthGate {
  readonly mode = "cuentas" as const;
  private handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  constructor(
    private auth: BetterAuthInstance,
    private pool: pg.Pool,
    private mailer: Mailer,
    private allowOutbox: boolean,
  ) {
    this.handler = toNodeHandler(auth) as unknown as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (url.pathname.startsWith("/api/auth/")) {
      await this.handler(req, res);
      return true;
    }
    // Bandeja del adaptador de pruebas: solo fuera de producción.
    if (url.pathname === "/api/dev/outbox" && req.method === "GET") {
      if (!this.allowOutbox || this.mailer.kind !== "prueba") {
        sendJson(res, 404, { error: "ruta", message: "Recurso no encontrado." });
        return true;
      }
      const to = url.searchParams.get("to") ?? "";
      const outbox = (this.mailer as unknown as { outbox: { to: string; kind: string; text: string; at: string }[] }).outbox;
      sendJson(res, 200, outbox.filter((m) => !to || m.to === to));
      return true;
    }
    return false;
  }

  async getSession(req: IncomingMessage): Promise<AuthSession | null> {
    const data = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!data?.session || !data.user) return null;
    if (!data.user.emailVerified) return null;
    return {
      sessionId: data.session.id,
      user: { id: data.user.id, name: data.user.name, email: data.user.email },
      createdAt: new Date(data.session.createdAt).getTime(),
    };
  }

  async isActive(sessionId: string) {
    const { rowCount } = await this.pool.query('SELECT 1 FROM "session" WHERE id = $1 AND "expiresAt" > now()', [sessionId]);
    return (rowCount ?? 0) > 0;
  }

  async revoke(session: AuthSession) {
    await this.pool.query('DELETE FROM "session" WHERE id = $1', [session.sessionId]);
  }

  clearCookies(https: boolean) {
    const names = [`${COOKIE_PREFIX}.session_token`, `${COOKIE_PREFIX}.session_data`];
    const all = https ? [...names.map((n) => `__Secure-${n}`), ...names] : names;
    return all.map((n) => `${n}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${n.startsWith("__Secure-") ? "; Secure" : ""}`);
  }

  async close() {}
}
