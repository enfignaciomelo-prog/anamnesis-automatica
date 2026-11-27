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
  /**
   * Eliminación automática del historial en el servidor (días sin actividad).
   * Desactivada por defecto: solo se aplica si el profesional la configura.
   * Es independiente de la limpieza local del dispositivo.
   */
  historyRetentionOptions: number[];
  idleDefaultMinutes: number;
  idleOptions: number[];
  /** Detrás de un proxy HTTPS (Render, Fly, etc.): confiar en X-Forwarded-Proto. */
  trustProxy: boolean;
  staticDir: string;
  /** Pausa automática si se pierde la conexión con la interfaz mientras se escucha. */
  disconnectPauseMs: number;
  /** OCR de PDF escaneados (requiere tesseract y pdftoppm en el servidor). */
  ocr: boolean;
  /** Cada cuánto el servidor revisa las sesiones con canales en vivo abiertos. */
  sessionCheckMs: number;
  /** Reloj ajustable para pruebas E2E del corte diario (nunca en producción). */
  testClock: boolean;
  providers: { anthropic: boolean; deepgram: boolean; database: boolean };
  database?: { url: string; ssl: "disable" | "verify"; caCert?: string };
  auth?: { secret: string; baseUrl: string };
  email?: { transport: "resend" | "prueba"; resendKey?: string; from?: string };
}

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
    historyRetentionOptions: [30, 90, 365],
    idleDefaultMinutes: demo ? 60 : 15,
    idleOptions: [5, 15, 30, 60],
    trustProxy: env.TRUST_PROXY === "true",
    staticDir: env.STATIC_DIR ?? "dist",
    disconnectPauseMs: Number(env.DISCONNECT_PAUSE_MS ?? 8000),
    ocr: env.OCR !== "false",
    sessionCheckMs: Math.max(100, Number(env.SESSION_CHECK_MS ?? 15_000)),
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

  // TLS de PostgreSQL: en producción, obligatorio y verificado contra el CA del proveedor.
  const dbUrl = env.DATABASE_URL!;
  let parsed: URL;
  try {
    parsed = new URL(dbUrl);
  } catch {
    throw new Error("DATABASE_URL no es una URL válida.");
  }
  const urlSslMode = parsed.searchParams.get("sslmode");
  const caCert = env.DATABASE_CA_CERT?.trim() || undefined;
  if (production) {
    if (env.DATABASE_SSL === "disable")
      throw new Error("En producción no se permite DATABASE_SSL=disable: la conexión a PostgreSQL debe usar TLS verificado.");
    if (urlSslMode && !["require", "verify-ca", "verify-full"].includes(urlSslMode))
      throw new Error(`En producción no se permite sslmode=${urlSslMode} en DATABASE_URL.`);
    if (!caCert)
      throw new Error("En producción falta DATABASE_CA_CERT: se requiere el certificado del proveedor para verificar PostgreSQL.");
    if (!caCert.includes("BEGIN CERTIFICATE"))
      throw new Error("DATABASE_CA_CERT no parece un certificado PEM.");
  }
  if (env.DATABASE_SSL && !["disable", "verify"].includes(env.DATABASE_SSL))
    throw new Error("DATABASE_SSL solo admite «verify» o «disable» (este último, solo fuera de producción).");
  return {
    ...base,
    database: {
      url: dbUrl,
      ssl: env.DATABASE_SSL === "disable" ? "disable" : "verify",
      caCert,
    },
    auth: { secret: env.BETTER_AUTH_SECRET!, baseUrl },
    email: { transport, resendKey: env.RESEND_API_KEY, from: env.EMAIL_FROM },
  };
}
