import type { IncomingMessage, ServerResponse } from "node:http";

export interface AuthUser {
  id: string;
  name: string;
  email?: string;
}

export interface AuthSession {
  /** Identificador de la sesión en el servidor (nunca el token de la cookie). */
  sessionId: string;
  user: AuthUser;
  /** Inicio de la sesión: el corte diario se calcula desde aquí. */
  createdAt: number;
}

/**
 * Identidad del profesional. La identidad SIEMPRE se obtiene de la sesión
 * del servidor; nunca de un identificador enviado por el navegador.
 */
export interface AuthGate {
  readonly mode: "demo" | "cuentas";
  /** Atiende rutas propias (p. ej., /api/auth/*). Devuelve true si respondió. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL, https: boolean): Promise<boolean>;
  getSession(req: IncomingMessage): Promise<AuthSession | null>;
  /** ¿La sesión sigue vigente en el servidor? (para cerrar canales abiertos si fue revocada). */
  isActive(sessionId: string): Promise<boolean>;
  /** Revoca la sesión en el servidor (cierre, corte diario o inactividad). */
  revoke(session: AuthSession): Promise<void>;
  /** Cabeceras Set-Cookie para borrar la cookie de sesión en el navegador. */
  clearCookies(https: boolean): string[];
  close(): Promise<void>;
}
