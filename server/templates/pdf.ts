/**
 * PDF: lectura de texto (sin ejecutar scripts del PDF) y, para escaneos, OCR
 * con tesseract si el servidor lo tiene instalado. Los campos de OCR siempre
 * quedan para revisión manual. No se intenta conservar el diseño del PDF.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { suggestConcept } from "../../shared/concepts";
import type { ImportCandidate } from "../../shared/types";
import { cleanLabel, looksLikeLabel } from "./xml";

const run = promisify(execFile);
const MAX_PAGES = 10;
const OCR_PAGES = 5;

export async function pdfLines(bytes: Buffer): Promise<string[][]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs 6 no evalúa código del PDF; tampoco se cargan fuentes ni scripts.
  const task = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages: string[][] = [];
  for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of tc.items as { str: string; transform: number[] }[]) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3;
      rows.set(y, [...(rows.get(y) ?? []), { x: it.transform[4], s: it.str }]);
    }
    pages.push(
      [...rows.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(" ").replace(/\s+/g, " ").trim()),
    );
  }
  await task.destroy();
  return pages;
}

async function hasCommand(cmd: string, arg: string) {
  try {
    await run(cmd, [arg], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function ocrAvailable() {
  return (await hasCommand("tesseract", "--version")) && (await hasCommand("pdftoppm", "-v"));
}

/** OCR en español de las primeras páginas. Sin shell: argumentos fijos y límite de tiempo. */
export async function ocrPdf(bytes: Buffer): Promise<string[][]> {
  const dir = await mkdtemp(join(tmpdir(), "aa-ocr-"));
  try {
    await writeFile(join(dir, "in.pdf"), bytes);
    await run("pdftoppm", ["-r", "200", "-gray", "-png", "-f", "1", "-l", String(OCR_PAGES), join(dir, "in.pdf"), join(dir, "p")], {
      timeout: 60_000,
    });
    const imgs = (await readdir(dir)).filter((f) => f.startsWith("p") && f.endsWith(".png")).sort();
    const pages: string[][] = [];
    for (const img of imgs) {
      const { stdout } = await run("tesseract", [join(dir, img), "stdout", "-l", "spa", "--psm", "4"], {
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      pages.push(stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    }
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function candidatesFromLines(pages: string[][], origin: "pdf" | "ocr"): ImportCandidate[] {
  const out: ImportCandidate[] = [];
  pages.forEach((lines, pi) => {
    let section = `Página ${pi + 1}`;
    lines.forEach((line, li) => {
      const t = line.trim();
      const isHeading = t.length >= 4 && t.length <= 60 && t === t.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{3}/.test(t) && !/[:：]/.test(t);
      if (isHeading) {
        section = cleanLabel(t.charAt(0) + t.slice(1).toLowerCase());
        return;
      }
      // Varias etiquetas en una línea («Peso: ___ Talla: ___»).
      const parts = t.split(/(?<=[:：]\s*[_.…]*)\s{2,}|(?<=_{3,})\s+/).filter(Boolean);
      for (const part of parts) {
        if (!looksLikeLabel(part)) continue;
        const label = cleanLabel(part);
        if (!label) continue;
        out.push({
          key: `${origin}:${pi}:${li}:${out.length}`,
          label,
          section,
          concept: suggestConcept(label) ?? null,
          target: null,
          include: true,
          origin,
        });
      }
    });
  });
  return out.slice(0, 200);
}

export async function analyzePdf(bytes: Buffer, ocrEnabled = true): Promise<{
  candidates: ImportCandidate[];
  warnings: string[];
  ocr: boolean;
}> {
  const warnings = ["El PDF se usa solo para proponer campos: la exportación no conserva su diseño."];
  let pages: string[][];
  try {
    pages = await pdfLines(bytes);
  } catch {
    return { candidates: [], warnings: ["No se pudo leer el PDF. Puede estar dañado o protegido."], ocr: false };
  }
  const chars = pages.flat().join("").length;
  if (chars >= 20) {
    const candidates = candidatesFromLines(pages, "pdf");
    if (!candidates.length) warnings.push("No se detectaron etiquetas del tipo «Campo:». Crea los campos a mano.");
    return { candidates, warnings, ocr: false };
  }
  // Escaneo: OCR con revisión manual obligatoria.
  if (ocrEnabled && (await ocrAvailable())) {
    try {
      const ocrPages = await ocrPdf(bytes);
      const candidates = candidatesFromLines(ocrPages, "ocr");
      warnings.push(
        "El PDF es un escaneo: los campos se obtuvieron por reconocimiento de texto (OCR) y pueden tener errores. Revisa cada uno.",
      );
      if (!candidates.length) warnings.push("El OCR no encontró etiquetas. Crea los campos a mano.");
      return { candidates, warnings, ocr: true };
    } catch {
      warnings.push("El reconocimiento de texto (OCR) falló. Crea los campos a mano.");
      return { candidates: [], warnings, ocr: true };
    }
  }
  warnings.push(
    "El PDF parece un escaneo y este servidor no tiene reconocimiento de texto (OCR). Crea los campos a mano.",
  );
  return { candidates: [], warnings, ocr: false };
}

