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
  deepgram?: { key: string };
  /** Proveedor simulado del llenado para pruebas E2E (ALLOW_TEST_FILL=true, nunca en producción). */
  testFill: boolean;
  /** Llenado asistido con Claude (CLAUDE_FILL=true, solo modo cuentas). La clave nunca sale del servidor. */
  claude?: { key: string; model: string; effort: "low" | "medium" | "high" | "xhigh" | "max"; timeoutMs: number };
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
  const transcription = env.TRANSCRIPTION_MODE ?? "demo";
  if (!["demo", "deepgram"].includes(transcription))
    throw new Error("TRANSCRIPTION_MODE admite «demo» o «deepgram».");
  const deepgramKey = env.DEEPGRAM_API_KEY?.trim();
  if (transcription === "deepgram" && (demo || !deepgramKey))
    throw new Error("Deepgram requiere DEMO_MODE=false y DEEPGRAM_API_KEY.");
  // Activación explícita: sin CLAUDE_FILL=true no hay llamadas a Claude, aunque exista la clave.
  const claudeOn = env.CLAUDE_FILL === "true";
  if (env.CLAUDE_FILL && !["true", "false"].includes(env.CLAUDE_FILL))
    throw new Error("CLAUDE_FILL admite «true» o «false».");
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  if (claudeOn && (demo || !anthropicKey))
    throw new Error("El llenado con Claude requiere DEMO_MODE=false y ANTHROPIC_API_KEY.");
  const effort = (env.CLAUDE_EFFORT ?? "high") as NonNullable<Config["claude"]>["effort"];
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
    throw new Error("CLAUDE_EFFORT admite low, medium, high, xhigh o max.");
  const model = (env.CLAUDE_MODEL ?? "claude-opus-5-5").trim();
  if (!/^claude-[a-z0-9.-]{3,60}$/.test(model)) throw new Error("CLAUDE_MODEL no es un identificador de modelo válido.");
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
    testFill: env.ALLOW_TEST_FILL === "true" && !production && demo,
    providers,
    ...(transcription === "deepgram" && deepgramKey ? { deepgram: { key: deepgramKey } } : {}),
    ...(claudeOn && anthropicKey
      ? {
          claude: {
            key: anthropicKey,
            model,
            effort,
            timeoutMs: Math.min(Math.max(Number(env.CLAUDE_TIMEOUT_MS ?? 180_000), 10_000), 600_000),
          },
        }
      : {}),
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
