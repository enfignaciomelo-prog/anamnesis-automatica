/**
 * Configuración desde variables de entorno. Las claves nunca salen del
 * servidor ni se imprimen en los registros.
 *
 * Modos:
 * - DEMO_MODE=true (predeterminado): perfiles ficticios, datos en memoria.
 * - DEMO_MODE=false: cuentas con Better Auth, PostgreSQL y correo real.
 */
export interface Config {
  port: number;
  demo: boolean;
  production: boolean;
  /** Multiplicador de velocidad de la entrevista ficticia (pruebas usan valores altos). */
  demoSpeed: number;
  retentionDefaultMinutes: number;
  retentionOptions: number[];
  idleDefaultMinutes: number;
  idleOptions: number[];
  /** Detrás de un proxy HTTPS (Render, Fly, etc.): confiar en X-Forwarded-Proto. */
  trustProxy: boolean;
  staticDir: string;
  /** Pausa automática si se pierde la conexión con la interfaz mientras se escucha. */
  disconnectPauseMs: number;
  /** OCR de PDF escaneados (requiere tesseract y pdftoppm en el servidor). */
  ocr: boolean;
  /** Reloj ajustable para pruebas E2E del corte diario (nunca en producción). */
  testClock: boolean;
  providers: { anthropic: boolean; deepgram: boolean; database: boolean };
  database?: { url: string; ssl: "disable" | "require"; caCert?: string };
  auth?: { secret: string; baseUrl: string };
  email?: { transport: "resend" | "prueba"; resendKey?: string; from?: string };
}

const DAY = 24 * 60;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const providers = {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    deepgram: Boolean(env.DEEPGRAM_API_KEY),
    database: Boolean(env.DATABASE_URL),
  };
  const demo = env.DEMO_MODE !== "false";
  const production = env.NODE_ENV === "production";
  const base: Config = {
    port: Number(env.PORT ?? 3000),
    demo,
    production,
    demoSpeed: Math.min(Math.max(Number(env.DEMO_SPEED ?? 1), 0.25), 100),
    retentionDefaultMinutes: demo ? 60 : 30 * DAY,
    retentionOptions: demo ? [15, 60, 240, 720] : [7 * DAY, 30 * DAY, 90 * DAY, 365 * DAY],
    idleDefaultMinutes: demo ? 60 : 15,
    idleOptions: [5, 15, 30, 60],
    trustProxy: env.TRUST_PROXY === "true",
    staticDir: env.STATIC_DIR ?? "dist",
    disconnectPauseMs: Number(env.DISCONNECT_PAUSE_MS ?? 8000),
    ocr: env.OCR !== "false",
    testClock: env.ALLOW_TEST_CLOCK === "true" && !production && demo,
    providers,
  };
  if (demo) return base;

  const missing = ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Faltan variables de entorno para el modo con cuentas: ${missing.join(", ")}.`);
  if ((env.BETTER_AUTH_SECRET ?? "").length < 32)
    throw new Error("BETTER_AUTH_SECRET debe tener al menos 32 caracteres aleatorios.");
  const baseUrl = env.BETTER_AUTH_URL!.replace(/\/+$/, "");
  if (production && !baseUrl.startsWith("https://")) throw new Error("En producción BETTER_AUTH_URL debe usar https://.");

  const transport = env.EMAIL_TRANSPORT === "prueba" ? "prueba" : "resend";
  if (transport === "prueba" && production)
    throw new Error(
      "EMAIL_TRANSPORT=prueba no se permite en producción: la verificación de correo debe enviarse de verdad. Configura RESEND_API_KEY y EMAIL_FROM.",
    );
  if (transport === "resend" && (!env.RESEND_API_KEY || !env.EMAIL_FROM))
    throw new Error("Faltan RESEND_API_KEY y EMAIL_FROM (o usa EMAIL_TRANSPORT=prueba fuera de producción).");

  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(env.DATABASE_URL!);
  return {
    ...base,
    database: {
      url: env.DATABASE_URL!,
      ssl: env.DATABASE_SSL === "disable" || (local && env.DATABASE_SSL !== "require") ? "disable" : "require",
      caCert: env.DATABASE_CA_CERT || undefined,
    },
    auth: { secret: env.BETTER_AUTH_SECRET!, baseUrl },
    email: { transport, resendKey: env.RESEND_API_KEY, from: env.EMAIL_FROM },
  };
}
