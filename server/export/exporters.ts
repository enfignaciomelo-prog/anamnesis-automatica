/**
 * Exportación del documento finalizado. No intenta reproducir diseños de
 * plantillas propias: genera un documento ordenado por secciones.
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { InterviewSnapshot } from "../../shared/types";
import { finalValue } from "../extraction/merge";

export interface ExportOptions {
  includeEvidence: boolean;
  professionalName: string;
}

interface Block {
  title: string;
  fields: { label: string; value: string; evidence: string[] }[];
}

function model(s: InterviewSnapshot): Block[] {
  return s.template.sections.map((sec) => ({
    title: sec.title,
    fields: sec.fields.map((f) => {
      const st = s.fields[f.id];
      return {
        label: f.label,
        value: finalValue(st),
        evidence: st.items.flatMap((i) =>
          i.evidence.map((e) => `[${fmtTime(e.start)}] «${e.quote}»`),
        ),
      };
    }),
  }));
}

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function header(s: InterviewSnapshot, o: ExportOptions): string[] {
  const when = s.finalizedAt
    ? new Intl.DateTimeFormat("es-CL", {
        timeZone: "America/Santiago",
        dateStyle: "long",
        timeStyle: "short",
      }).format(new Date(s.finalizedAt))
    : "";
  const lines = [
    `Plantilla: ${s.templateName}`,
    `Revisado y confirmado por: ${o.professionalName}`,
    `Finalizado: ${when}`,
  ];
  if (s.demo) lines.unshift("DOCUMENTO DE DEMOSTRACIÓN — DATOS FICTICIOS");
  return lines;
}

export function exportText(s: InterviewSnapshot, o: ExportOptions): string {
  const out: string[] = ["ANAMNESIS", ...header(s, o), ""];
  for (const b of model(s)) {
    out.push(b.title.toUpperCase());
    for (const f of b.fields) {
      out.push(`${f.label}: ${f.value}`);
      if (o.includeEvidence) for (const e of f.evidence) out.push(`    Respaldo ${e}`);
    }
    out.push("");
  }
  return out.join("\n");
}

export async function exportDocx(s: InterviewSnapshot, o: ExportOptions): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Anamnesis")] }),
    ...header(s, o).map(
      (l, i) =>
        new Paragraph({
          children: [new TextRun({ text: l, bold: s.demo && i === 0, size: 20 })],
        }),
    ),
  ];
  for (const b of model(s)) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(b.title)] }));
    for (const f of b.fields) {
      children.push(
        new Paragraph({
          spacing: { after: 80 },
          children: [new TextRun({ text: `${f.label}: `, bold: true }), new TextRun(f.value)],
        }),
      );
      if (o.includeEvidence)
        for (const e of f.evidence)
          children.push(
            new Paragraph({
              indent: { left: 360 },
              children: [new TextRun({ text: `Respaldo ${e}`, italics: true, size: 18, color: "555555" })],
            }),
          );
    }
  }
  const doc = new Document({
    creator: "Anamnesis Automática",
    title: "Anamnesis",
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4
            margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
          },
        },
        children: [
          ...children,
          new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { before: 240 },
            children: [
              new TextRun({
                text: "Generado con Anamnesis Automática a partir de la transcripción y revisado por el profesional.",
                size: 16,
                color: "666666",
              }),
            ],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/** Helvetica estándar usa WinAnsi: cubre el español; lo demás se reemplaza. */
function winAnsi(t: string): string {
  return t
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E -ÿ]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

export async function exportPdf(s: InterviewSnapshot, o: ExportOptions): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Anamnesis");
  pdf.setCreator("Anamnesis Automática");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const W = 595.28;
  const H = 841.89;
  const M = 56;
  let page = pdf.addPage([W, H]);
  let y = H - M;

  const line = (text: string, font: PDFFont, size: number, color = rgb(0.1, 0.13, 0.18), indent = 0) => {
    for (const l of wrap(winAnsi(text), font, size, W - 2 * M - indent)) {
      if (y < M + size) {
        page = pdf.addPage([W, H]);
        y = H - M;
      }
      page.drawText(l, { x: M + indent, y, size, font, color });
      y -= size * 1.4;
    }
  };

  line("Anamnesis", bold, 20);
  y -= 4;
  for (const h of header(s, o)) line(h, regular, 9.5, rgb(0.35, 0.38, 0.42));
  for (const b of model(s)) {
    y -= 10;
    line(b.title, bold, 13);
    for (const f of b.fields) {
      line(`${f.label}: ${f.value}`, regular, 10.5);
      if (o.includeEvidence)
        for (const e of f.evidence) line(`Respaldo ${e}`, italic, 8.5, rgb(0.4, 0.4, 0.4), 14);
      y -= 2;
    }
  }
  return Buffer.from(await pdf.save());
}

