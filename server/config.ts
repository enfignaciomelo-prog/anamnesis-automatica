/** Configuración desde variables de entorno. Las claves nunca salen del servidor. */
export interface Config {
  port: number;
  demo: boolean;
  /** Multiplicador de velocidad de la entrevista ficticia (pruebas usan valores altos). */
  demoSpeed: number;
  retentionDefaultMinutes: number;
  retentionOptions: number[];
  /** Detrás de un proxy HTTPS (Render, Fly, etc.): confiar en X-Forwarded-Proto. */
  trustProxy: boolean;
  staticDir: string;
  /** Pausa automática si se pierde la conexión con la interfaz mientras se escucha. */
  disconnectPauseMs: number;
  /** OCR de PDF escaneados (requiere tesseract y pdftoppm en el servidor). */
  ocr: boolean;
  providers: { anthropic: boolean; deepgram: boolean; database: boolean };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const providers = {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    deepgram: Boolean(env.DEEPGRAM_API_KEY),
    database: Boolean(env.DATABASE_URL),
  };
  const demo = env.DEMO_MODE !== "false";
  if (!demo) {
    // Cuentas reales, PostgreSQL y proveedores llegan en etapas 3–5.
    throw new Error(
      "DEMO_MODE=false aún no está disponible: cuentas, persistencia y proveedores reales están pendientes (etapas 3 a 5).",
    );
  }
  return {
    port: Number(env.PORT ?? 3000),
    demo,
    demoSpeed: Math.min(Math.max(Number(env.DEMO_SPEED ?? 1), 0.25), 100),
    retentionDefaultMinutes: 60,
    retentionOptions: [15, 60, 240, 720],
    trustProxy: env.TRUST_PROXY === "true",
    staticDir: env.STATIC_DIR ?? "dist",
    disconnectPauseMs: Number(env.DISCONNECT_PAUSE_MS ?? 8000),
    ocr: env.OCR !== "false",
    providers,
  };
}
