/**
 * Excel: detección de etiquetas y celdas destino, y llenado de una copia del
 * original escribiendo solo en las celdas mapeadas (skill xlsx). Las fórmulas
 * nunca se evalúan ni se modifican; una celda con fórmula no se puede mapear.
 */
import type JSZip from "jszip";
import { suggestConcept } from "../../shared/concepts";
import type { ImportCandidate } from "../../shared/types";
import { attr, cleanLabel, decodeXml, escapeXml, looksLikeLabel } from "./xml";

export const CELL_RE = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;

export function colToNum(col: string) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function numToCol(n: number) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
function splitRef(ref: string) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  return { col: m[1], row: Number(m[2]) };
}

interface SheetInfo {
  name: string;
  path: string;
}

export async function sheetsOf(zip: JSZip): Promise<SheetInfo[]> {
  const wb = await zip.file("xl/workbook.xml")!.async("string");
  const rels = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  const relMap = new Map<string, string>();
  for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(r[0], "Id");
    const target = attr(r[0], "Target");
    if (id && target) relMap.set(id, target);
  }
  const out: SheetInfo[] = [];
  for (const s of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(s[0], "name");
    const rid = attr(s[0], "r:id");
    const target = rid ? relMap.get(rid) : undefined;
    if (!name || !target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    if (zip.file(path)) out.push({ name, path });
  }
  return out;
}

async function sharedStrings(zip: JSZip): Promise<string[]> {
  const xml = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    decodeXml([...si[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("")),
  );
}

interface Cell {
  ref: string;
  text: string | null;
  formula: boolean;
  hasValue: boolean;
}

function readCells(xml: string, shared: string[]): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const tag = `<c${c[1]}>`;
    const ref = attr(tag, "r");
    if (!ref) continue;
    const body = c[2] ?? "";
    const t = attr(tag, "t");
    const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
    let text: string | null = null;
    if (t === "s" && v !== undefined) text = shared[Number(v)] ?? null;
    else if (t === "inlineStr") text = decodeXml([...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => x[1]).join(""));
    else if (t === "str" && v !== undefined) text = decodeXml(v);
    cells.set(ref, { ref, text, formula: /<f[\s>/]/.test(body), hasValue: v !== undefined || text !== null });
  }
  return cells;
}

export async function analyzeXlsx(zip: JSZip): Promise<{ candidates: ImportCandidate[]; warnings: string[]; sheets: string[] }> {
  const sheets = await sheetsOf(zip);
  const shared = await sharedStrings(zip);
  const wb = await zip.file("xl/workbook.xml")!.async("string");
  const candidates: ImportCandidate[] = [];
  const warnings: string[] = [];
  const cellsBySheet = new Map<string, Map<string, Cell>>();
  for (const s of sheets) cellsBySheet.set(s.name, readCells(await zip.file(s.path)!.async("string"), shared));

  // Nombres definidos que apuntan a una celda: correspondencia explícita.
  for (const d of wb.matchAll(/<definedName\b([^>]*)>([^<]*)<\/definedName>/g)) {
    const name = attr(`<x${d[1]}>`, "name") ?? "";
    const ref = decodeXml(d[2]).replace(/\$/g, "");
    const m = /^'?(.+?)'?!([A-Z]{1,3}\d+)$/.exec(ref);
    if (!name || name.startsWith("_xlnm") || !m || !cellsBySheet.has(m[1])) continue;
    const label = cleanLabel(name.replace(/[_.]+/g, " "));
    const cell = cellsBySheet.get(m[1])!.get(m[2]);
    candidates.push({
      key: `dn:${name}`,
      label,
      section: m[1],
      concept: suggestConcept(label) ?? null,
      target: { kind: "cell", sheet: m[1], cell: m[2] },
      include: !cell?.formula,
      problem: cell?.formula ? "La celda tiene una fórmula" : undefined,
      origin: "nombre_definido",
    });
  }

  for (const s of sheets) {
    const cells = cellsBySheet.get(s.name)!;
    for (const c of cells.values()) {
      if (!c.text) continue;
      const t = c.text.trim();
      const strong = looksLikeLabel(t);
      const weak = !strong && t.length >= 3 && t.length <= 50 && /[a-záéíóúñ]/i.test(t) && !/\d{3,}/.test(t);
      if (!strong && !weak) continue;
      const { col, row } = splitRef(c.ref);
      const right = `${numToCol(colToNum(col) + 1)}${row}`;
      const rc = cells.get(right);
      if (rc?.text && !strong) continue; // la celda de la derecha ya tiene texto: probablemente un encabezado
      const label = cleanLabel(t);
      if (!label) continue;
      candidates.push({
        key: `c:${s.name}!${c.ref}`,
        label,
        section: s.name,
        concept: suggestConcept(label) ?? null,
        target: { kind: "cell", sheet: s.name, cell: right },
        include: strong && !rc?.formula,
        problem: rc?.formula ? "La celda destino tiene una fórmula" : undefined,
        origin: "celda",
      });
      if (candidates.length >= 200) break;
    }
  }
  if (!candidates.length)
    warnings.push("No se detectaron etiquetas. Escribe las etiquetas terminadas en «:» o crea los campos a mano.");
  if (sheets.length === 0) warnings.push("No se encontraron hojas legibles en el libro.");
  return { candidates, warnings, sheets: sheets.map((s) => s.name) };
}

export async function cellHasFormula(zip: JSZip, sheet: string, cell: string): Promise<boolean | null> {
  const s = (await sheetsOf(zip)).find((x) => x.name === sheet);
  if (!s) return null;
  const xml = await zip.file(s.path)!.async("string");
  return readCells(xml, []).get(cell)?.formula ?? false;
}

function cellXml(ref: string, style: string | undefined, value: string) {
  return `<c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

export interface XlsxFill {
  sheet: string;
  cell: string;
  value: string;
}

/** Escribe valores como texto (nunca como fórmula) en las celdas indicadas. */
export async function fillXlsx(zip: JSZip, fills: XlsxFill[]): Promise<{ placed: number; skipped: string[] }> {
  const sheets = await sheetsOf(zip);
  const skipped: string[] = [];
  let placed = 0;
  const bySheet = new Map<string, XlsxFill[]>();
  for (const f of fills) bySheet.set(f.sheet, [...(bySheet.get(f.sheet) ?? []), f]);

  for (const [sheetName, list] of bySheet) {
    const s = sheets.find((x) => x.name === sheetName);
    if (!s) {
      skipped.push(...list.map((f) => `${f.sheet}!${f.cell}`));
      continue;
    }
    let xml = await zip.file(s.path)!.async("string");
    if (/<sheetData\s*\/>/.test(xml)) xml = xml.replace(/<sheetData\s*\/>/, "<sheetData></sheetData>");
    for (const f of list) {
      if (!CELL_RE.test(f.cell)) {
        skipped.push(`${f.sheet}!${f.cell}`);
        continue;
      }
      const { col, row } = splitRef(f.cell);
      const cellRe = new RegExp(`<c\\b[^>]*\\sr="${f.cell}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
      const existing = cellRe.exec(xml);
      if (existing) {
        if (/<f[\s>/]/.test(existing[0])) {
          skipped.push(`${f.sheet}!${f.cell}`);
          continue;
        }
        const style = attr(existing[0].slice(0, existing[0].indexOf(">") + 1), "s");
        xml = xml.slice(0, existing.index) + cellXml(f.cell, style, f.value) + xml.slice(existing.index + existing[0].length);
        placed++;
        continue;
      }
      const rowRe = new RegExp(`<row\\b[^>]*\\sr="${row}"[^>]*?(?:/>|>([\\s\\S]*?)</row>)`);
      const r = rowRe.exec(xml);
      if (r) {
        let rowXml = r[0];
        if (rowXml.endsWith("/>")) rowXml = rowXml.slice(0, -2) + "></row>";
        const open = rowXml.slice(0, rowXml.indexOf(">") + 1);
        let inner = rowXml.slice(open.length, -"</row>".length);
        const target = colToNum(col);
        let insertAt = inner.length;
        for (const c of inner.matchAll(/<c\b[^>]*\sr="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
          if (colToNum(c[1]) > target) {
            insertAt = c.index!;
            break;
          }
        }
        inner = inner.slice(0, insertAt) + cellXml(f.cell, undefined, f.value) + inner.slice(insertAt);
        xml = xml.slice(0, r.index) + open + inner + "</row>" + xml.slice(r.index + r[0].length);
      } else {
        const sd = /<sheetData>([\s\S]*?)<\/sheetData>/.exec(xml);
        if (!sd) {
          skipped.push(`${f.sheet}!${f.cell}`);
          continue;
        }
        const start = sd.index + "<sheetData>".length;
        let insertAt = start + sd[1].length;
        for (const rr of sd[1].matchAll(/<row\b[^>]*\sr="(\d+)"/g)) {
          if (Number(rr[1]) > row) {
            insertAt = start + rr.index!;
            break;
          }
        }
        xml = xml.slice(0, insertAt) + `<row r="${row}">${cellXml(f.cell, undefined, f.value)}</row>` + xml.slice(insertAt);
      }
      placed++;
    }
    zip.file(s.path, xml);
  }
  return { placed, skipped };
}
