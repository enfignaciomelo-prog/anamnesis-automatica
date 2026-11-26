// Compilación de la interfaz con esbuild, para entornos sin acceso al registro
// npm (no hay Vite instalado). Produce lo mismo que `vite build`: dist/ con
// index.html, assets/ con nombres con hash, archivos de public/ y sw.js versionado.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const out = "dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/assets`, { recursive: true });

const result = await build({
  entryPoints: { app: "web/main.tsx" },
  bundle: true,
  format: "esm",
  target: ["safari16", "chrome115"],
  jsx: "automatic",
  minify: true,
  sourcemap: false,
  outdir: `${out}/assets`,
  entryNames: "[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
  logLevel: "warning",
});

const files = Object.keys(result.metafile.outputs).map((p) => p.replace(`${out}/`, ""));
const js = files.find((f) => f.endsWith(".js"));
const css = files.find((f) => f.endsWith(".css"));

cpSync("public", out, { recursive: true });

let html = readFileSync("index.html", "utf8").replace(
  /<script type="module" src="\/web\/main.tsx"><\/script>/,
  `<script type="module" src="/${js}"></script>`,
);
if (css) html = html.replace("</head>", `  <link rel="stylesheet" href="/${css}" />\n  </head>`);
writeFileSync(`${out}/index.html`, html);

const version = createHash("sha256")
  .update(readdirSync(`${out}/assets`).sort().join("|"))
  .digest("hex")
  .slice(0, 12);
const sw = readFileSync(`${out}/sw.js`, "utf8").replace("__BUILD_VERSION__", version);
writeFileSync(`${out}/sw.js`, sw);
console.log(`Interfaz compilada en ${out}/ (${js}, ${css ?? "sin css"}, sw ${version})`);
