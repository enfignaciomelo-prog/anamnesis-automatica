/**
 * Word: detección de campos (marcadores y etiquetas) y llenado de una copia del
 * original. Se edita el XML en su lugar, sin reformatear (skill docx).
 */
import type JSZip from "jszip";
import { suggestConcept } from "../../shared/concepts";
import type { ImportCandidate } from "../../shared/types";
import { attr, cleanLabel, decodeXml, escapeXml, looksLikeLabel } from "./xml";

const PARA_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

interface Para {
  index: number;
  start: number;
  end: number;
  xml: string;
  text: string;
  heading: boolean;
  bookmarks: string[];
}

function paragraphs(doc: string): Para[] {
  const out: Para[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  PARA_RE.lastIndex = 0;
  while ((m = PARA_RE.exec(doc))) {
    const xml = m[0];
    const text = decodeXml(
      [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map((t) => t[1] ?? " ").join(""),
    );
    const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(xml)?.[1] ?? "";
    const bookmarks = [...xml.matchAll(/<w:bookmarkStart\b[^>]*>/g)]
      .map((b) => attr(b[0], "w:name") ?? "")
      .filter((n) => n && !n.startsWith("_"));
    out.push({
      index: i++,
      start: m.index,
      end: m.index + xml.length,
      xml,
      text,
      heading: /heading|t[ií]?tulo|title/i.test(style),
      bookmarks,
    });
  }
  return out;
}

function humanize(name: string) {
  const s = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export async function analyzeDocx(zip: JSZip): Promise<{ candidates: ImportCandidate[]; warnings: string[] }> {
  const doc = await zip.file("word/document.xml")!.async("string");
  const paras = paragraphs(doc);
  const candidates: ImportCandidate[] = [];
  const warnings: string[] = [];
  let section = "General";

  // Marcadores fuera de párrafos (a nivel del cuerpo).
  const inParas = new Set(paras.flatMap((p) => p.bookmarks));
  for (const b of doc.matchAll(/<w:bookmarkStart\b[^>]*>/g)) {
    const name = attr(b[0], "w:name") ?? "";
    if (name && !name.startsWith("_") && !inParas.has(name)) {
      const label = cleanLabel(humanize(name));
      candidates.push({
        key: `bm:${name}`,
        label,
        section,
        concept: suggestConcept(label) ?? null,
        target: { kind: "bookmark", name },
        include: true,
        origin: "marcador",
      });
    }
  }

  for (const p of paras) {
    const t = p.text.trim();
    if (p.heading && t && t.length <= 80) {
      section = cleanLabel(t);
      continue;
    }
    if (p.bookmarks.length) {
      for (const name of p.bookmarks) {
        const label = cleanLabel(looksLikeLabel(t) || (t && t.length <= 80) ? t : humanize(name)) || humanize(name);
        candidates.push({
          key: `bm:${name}`,
          label,
          section,
          concept: suggestConcept(label) ?? suggestConcept(name) ?? null,
          target: { kind: "bookmark", name },
          include: true,
          origin: "marcador",
        });
      }
      continue;
    }
    if (looksLikeLabel(t)) {
      const label = cleanLabel(t);
      if (!label) continue;
      candidates.push({
        key: `p:${p.index}`,
        label,
        section,
        concept: suggestConcept(label) ?? null,
        target: { kind: "paragraph", index: p.index, text: label },
        include: true,
        origin: "etiqueta",
      });
    }
  }
  if (!candidates.length)
    warnings.push(
      "No se detectaron campos. Agrega marcadores en Word o líneas del tipo «Alergias:», o crea los campos a mano.",
    );
  if (/<w:txbxContent/.test(doc))
    warnings.push("El documento tiene cuadros de texto: los campos dentro de ellos pueden no detectarse bien.");
  return { candidates: candidates.slice(0, 200), warnings };
}

function run(value: string) {
  const lines = value.split(/\r?\n/);
  const inner = lines
    .map((l, i) => `${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(l)}</w:t>`)
    .join("");
  return `<w:r>${inner}</w:r>`;
}

export interface DocxFill {
  target: { kind: "bookmark"; name: string } | { kind: "paragraph"; index: number; text: string };
  value: string;
}

/**
 * Inserta los valores en una copia del documento. Devuelve cuántos se ubicaron.
 * Marcador: el texto va justo después del inicio del marcador.
 * Etiqueta: el texto va al final del párrafo de la etiqueta.
 */
export async function fillDocx(zip: JSZip, fills: DocxFill[]): Promise<{ placed: number; missing: string[] }> {
  let doc = await zip.file("word/document.xml")!.async("string");
  const paras = paragraphs(doc);
  const inserts: { at: number; xml: string }[] = [];
  const missing: string[] = [];

  for (const f of fills) {
    if (f.target.kind === "paragraph") {
      const p = paras[f.target.index];
      if (!p || cleanLabel(p.text) !== f.target.text) {
        missing.push(f.target.text);
        continue;
      }
      if (p.xml.endsWith("/>")) {
        inserts.push({ at: p.start, xml: "" }); // párrafo vacío: se reemplaza abajo
        missing.push(f.target.text);
        continue;
      }
      inserts.push({ at: p.end - "</w:p>".length, xml: run(` ${f.value}`) });
    } else {
      const name = f.target.name;
      const re = new RegExp(`<w:bookmarkStart\\b[^>]*w:name="${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/>`);
      const m = re.exec(doc);
      if (!m) {
        missing.push(name);
        continue;
      }
      const at = m.index + m[0].length;
      const insidePara = paras.some((p) => p.start < m.index && m.index < p.end);
      inserts.push({ at, xml: insidePara ? run(f.value) : `<w:p>${run(f.value)}</w:p>` });
    }
  }
  inserts
    .filter((i) => i.xml)
    .sort((a, b) => b.at - a.at)
    .forEach((i) => {
      doc = doc.slice(0, i.at) + i.xml + doc.slice(i.at);
    });
  zip.file("word/document.xml", doc);
  return { placed: fills.length - missing.length, missing };
}
