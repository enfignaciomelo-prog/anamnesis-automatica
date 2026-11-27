import { createApp } from "../../server/app";
import { loadConfig } from "../../server/config";
import { mockDeepgram } from "../mockDeepgram";

const provider = await mockDeepgram();
const config = { ...loadConfig(), deepgram: { key: "ficticia" } };
const app = createApp(config, { connectDeepgram: provider.connect });
app.server.listen(config.port, "127.0.0.1");
process.once("SIGTERM", async () => {
  await app.close();
  await provider.close();
});
