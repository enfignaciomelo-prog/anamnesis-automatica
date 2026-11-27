import { createApp, type AppDeps } from "./app";
import { loadConfig } from "./config";
import { logError, logEvent } from "./log";

const config = loadConfig();

async function main() {
  let deps: AppDeps = {};
  if (!config.demo) {
    // Módulos con dependencias externas (pg, better-auth): solo en modo cuentas.
    const { setupReal } = await import("./real/setup");
    deps = await setupReal(config);
  }
  if (config.testFill) {
    // Solo pruebas E2E fuera de producción: llenado simulado, sin llamadas externas.
    const { TestFillProvider } = await import("./extraction/testFillProvider");
    deps = { ...deps, fillProvider: new TestFillProvider() };
  }
  const app = createApp(config, deps);
  app.server.listen(config.port, () => {
    // Solo indica qué está activo; nunca imprime claves.
    logEvent("server_started", {
      port: config.port,
      demo: config.demo,
      auth: app.gate.mode,
      store: app.store.kind,
      email: config.email?.transport ?? "ninguno",
      anthropic: config.providers.anthropic,
      claude_fill: Boolean(config.claude),
      claude_model: config.claude?.model ?? "ninguno",
      deepgram: config.providers.deepgram,
    });
  });
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((e) => {
  logError("startup", e);
  // Mensaje de configuración (sin secretos) para diagnosticar desde el panel del proveedor.
  if (e instanceof Error && /variables|BETTER_AUTH|RESEND|EMAIL_TRANSPORT|https/.test(e.message))
    process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
