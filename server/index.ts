import { createApp } from "./app";
import { loadConfig } from "./config";
import { logEvent } from "./log";

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, () => {
  // Solo indica qué está activo; nunca imprime claves.
  logEvent("server_started", {
    port: config.port,
    demo: config.demo,
    anthropic: config.providers.anthropic,
    deepgram: config.providers.deepgram,
    database: config.providers.database,
  });
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
