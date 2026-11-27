import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Versiona sw.js con el contenido compilado (igual que scripts/build-web-offline.mjs). */
function swVersion(): Plugin {
  return {
    name: "sw-version",
    apply: "build",
    closeBundle() {
      const assets = readdirSync("dist/assets").sort().join("|");
      const v = createHash("sha256").update(assets).digest("hex").slice(0, 12);
      const list = readdirSync("dist/assets").sort().map((f) => JSON.stringify(`/assets/${f}`)).join(",");
      const sw = readFileSync("dist/sw.js", "utf8").replace("__BUILD_VERSION__", v).replace("/*__ASSETS__*/", list);
      writeFileSync("dist/sw.js", sw);
    },
  };
}

export default defineConfig({
  plugins: [react(), swVersion()],
  publicDir: "public",
  build: { outDir: "dist", target: ["safari16", "chrome115"], sourcemap: false },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
