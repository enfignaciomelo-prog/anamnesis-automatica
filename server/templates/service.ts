/**
 * Plantillas por profesional: predeterminada (solo lectura), propias con
 * versiones inmutables, importación con confirmación y llenado del original.
 */
import { randomBytes, randomUUID } from "node:crypto";
import JSZip from "jszip";
import { z } from "zod";
import { CONCEPT_IDS, conceptInfo } from "../../shared/concepts";
import { GENERIC_TEMPLATE, allFields } from "../../shared/template-generic";
import type {
  FieldTarget,
  ImportAnalysis,
  InterviewSnapshot,
  Template,
  TemplateDetail,
  TemplateField,
  TemplateSection,
  TemplateSummary,
} from "../../shared/types";
import { finalValue } from "../extraction/merge";
import { HttpError } from "../http";
import { logEvent } from "../log";
import type { Store, TemplateRecord } from "../store";
import { analyzeDocx, fillDocx } from "./docx";
import { analyzePdf } from "./pdf";
import { detectKind, openOfficeZip } from "./safety";
import { CELL_RE, analyzeXlsx, cellHasFormula, fillXlsx, sheetsOf } from "./xlsx";
import { escapeXml, stripControl } from "./xml";

const IMPORT_TTL_MS = 60 * 60 * 1000;
const MAX_VERSIONS = 50;
const ID_RE = /^[a-z0-9_-]{1,48}$/;

const targetSchema = z.union([
  z.object({ kind: z.literal("bookmark"), name: z.string().min(1).max(80) }),
  z.object({ kind: z.literal("paragraph"), index: z.number().int().min(0).max(100000), text: z.string().max(120) }),
  z.object({
    kind: z.literal("cell"),
    sheet: z.string().min(1).max(31),
    cell: z.string().regex(CELL_RE, "Celda no válida (ejemplo: B5)"),
  }),
]);

const fieldSchema = z.object({
  id: z.string().regex(ID_RE).optional(),
  label: z.string().trim().min(1, "Cada campo necesita un nombre").max(120),
  hint: z.string().max(300).optional(),
  concept: z.enum(CONCEPT_IDS as [string, ...string[]]).nullable().optional(),
  critical: z.boolean().optional(),
  manualOnly: z.boolean().optional(),
  target: targetSchema.nullable().optional(),
});

const sectionSchema = z.object({
  id: z.string().regex(ID_RE).optional(),
  title: z.string().trim().min(1, "Cada sección necesita un título").max(80),
  fields: z.array(fieldSchema).max(60),
});

export const templateInputSchema = z.object({
  name: z.string().trim().min(1, "La plantilla necesita un nombre").max(80),
  sections: z.array(sectionSchema).min(1, "Agrega al menos una sección").max(30),
  note: z.string().max(200).optional(),
});

export type TemplateInput = z.infer<typeof templateInputSchema>;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, "plantilla_invalida", first?.message && !first.message.startsWith("Invalid") ? first.message : "Los datos de la plantilla no son válidos.");
  }
  return r.data;
}

function slug(label: string) {
  return (
    label
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 32) || "campo"
  );
}

/** Normaliza secciones: ids únicos y estables, tipos críticos siempre en revisión. */
function normalizeSections(input: TemplateInput["sections"]): TemplateSection[] {
  const used = new Set<string>();
  const unique = (base: string) => {
    let id = base;
    while (used.has(id)) id = `${base}_${randomBytes(2).toString("hex")}`;
    used.add(id);
    return id;
  };
  const total = input.reduce((n, s) => n + s.fields.length, 0);
  if (total > 150) throw new HttpError(400, "plantilla_grande", "Una plantilla admite hasta 150 campos.");
  return input.map((s) => ({
    id: unique(s.id ?? `sec_${slug(s.title)}`),
    title: stripControl(s.title),
    fields: s.fields.map((f): TemplateField => {
      const info = conceptInfo(f.concept ?? undefined);
      const field: TemplateField = {
        id: unique(f.id ?? slug(f.label)),
        label: stripControl(f.label),
      };
      if (f.hint) field.hint = stripControl(f.hint);
      if (info && !f.manualOnly) field.concept = info.id;
      if (f.critical || info?.critical) field.critical = true;
      if (f.manualOnly) field.manualOnly = true;
      if (f.target) field.target = f.target;
      return field;
    }),
  }));
}

export class TemplateService {
  constructor(private store: Store) {}

  private generic(): TemplateDetail {
    return {
      ...GENERIC_TEMPLATE,
      builtIn: true,
      versions: [{ version: GENERIC_TEMPLATE.version, createdAt: "2026-11-26T00:00:00.000Z", note: "Predeterminada" }],
    };
  }

  private toTemplate(t: TemplateRecord, version?: number): Template {
    const v = version ? t.versions.find((x) => x.version === version) : t.versions[t.versions.length - 1];
    if (!v) throw new HttpError(404, "version", "Esa versión no existe.");
    return { id: t.id, name: t.name, version: v.version, sections: structuredClone(v.sections), source: t.source };
  }

  private async own(ownerId: string, id: string) {
    const t = await this.store.getTemplate(ownerId, id);
    if (!t) throw new HttpError(404, "plantilla_no_encontrada", "La plantilla no existe o fue eliminada.");
    return t;
  }

  async list(ownerId: string): Promise<TemplateSummary[]> {
    const g = this.generic();
    return [
      {
        id: g.id,
        name: g.name,
        version: g.version,
        builtIn: true,
        sourceKind: null,
        updatedAt: g.versions[0].createdAt,
        fieldCount: allFields(g).length,
      },
      ...(await this.store.listTemplates(ownerId)).map((t) => {
        const last = t.versions[t.versions.length - 1];
        return {
          id: t.id,
          name: t.name,
          version: last.version,
          builtIn: false,
          sourceKind: t.source?.kind ?? null,
          updatedAt: new Date(t.updatedAt).toISOString(),
          fieldCount: last.sections.reduce((n, s) => n + s.fields.length, 0),
        };
      }),
    ];
  }

  async detail(ownerId: string, id: string, version?: number): Promise<TemplateDetail> {
    if (id === GENERIC_TEMPLATE.id) return this.generic();
    const t = await this.own(ownerId, id);
    return {
      ...this.toTemplate(t, version),
      builtIn: false,
      versions: t.versions.map((v) => ({ version: v.version, createdAt: new Date(v.createdAt).toISOString(), note: v.note })),
    };
  }

  /** Plantilla (última versión) para iniciar una entrevista. */
  async resolve(ownerId: string, id: string | undefined): Promise<Template> {
    if (!id || id === GENERIC_TEMPLATE.id) return structuredClone(GENERIC_TEMPLATE);
    return this.toTemplate(await this.own(ownerId, id));
  }

  /** Versión exacta (borradores sin conexión): nunca se usan secciones enviadas por el navegador. */
  async resolveVersion(ownerId: string, id: string, version: number): Promise<Template> {
    if (id === GENERIC_TEMPLATE.id) {
      if (version !== GENERIC_TEMPLATE.version) throw new HttpError(404, "version", "Esa versión no existe.");
      return structuredClone(GENERIC_TEMPLATE);
    }
    return this.toTemplate(await this.own(ownerId, id), version);
  }

  /** Última versión de todas las plantillas disponibles (paquete sin conexión). */
  async allCurrent(ownerId: string): Promise<Template[]> {
    const own = await this.store.listTemplates(ownerId);
    return [structuredClone(GENERIC_TEMPLATE), ...own.map((t) => this.toTemplate(t))];
  }

  async create(ownerId: string, body: unknown, fromId?: string): Promise<TemplateDetail> {
    let input: TemplateInput;
    let source: TemplateRecord["source"];
    if (fromId) {
      const base = await this.detail(ownerId, fromId);
      input = { name: `${base.name} (copia)`.slice(0, 80), sections: base.sections };
      // La copia conserva el archivo original para exportar en su formato.
      source = base.source;
    } else input = parse(templateInputSchema, body);
    const now = Date.now();
    const rec: TemplateRecord = {
      id: `tpl_${randomUUID()}`,
      ownerId,
      name: stripControl(input.name),
      createdAt: now,
      updatedAt: now,
      source,
      versions: [{ version: 1, createdAt: now, note: fromId ? "Copia" : "Creada", sections: normalizeSections(input.sections) }],
    };
    await this.store.saveTemplate(rec);
    logEvent("template_created");
    return this.detail(ownerId, rec.id);
  }

  /** Guarda una versión nueva; las entrevistas anteriores conservan la suya. */
  async update(ownerId: string, id: string, body: unknown): Promise<TemplateDetail> {
    if (id === GENERIC_TEMPLATE.id)
      throw new HttpError(403, "predeterminada", "La plantilla predeterminada no se edita. Duplícala para modificarla.");
    const t = await this.own(ownerId, id);
    const raw = body as { baseVersion?: unknown };
    const input = parse(templateInputSchema, body);
    const last = t.versions[t.versions.length - 1];
    if (raw.baseVersion !== last.version)
      throw new HttpError(409, "version_desactualizada", "La plantilla cambió mientras editabas. Recarga y vuelve a aplicar tus cambios.");
    const sections = normalizeSections(input.sections);
    await this.validateTargets(ownerId, t.source, sections);
    if (t.versions.length >= MAX_VERSIONS) t.versions.shift();
    t.versions.push({ version: last.version + 1, createdAt: Date.now(), note: input.note ?? "Editada", sections });
    t.name = stripControl(input.name);
    t.updatedAt = Date.now();
    await this.store.saveTemplate(t);
    logEvent("template_versioned");
    return this.detail(ownerId, id);
  }

  async delete(ownerId: string, id: string) {
    const t = await this.own(ownerId, id);
    await this.store.deleteTemplate(ownerId, id);
    const fileId = t.source?.fileId;
    if (fileId && !(await this.store.fileInUse(ownerId, fileId))) await this.store.deleteFile(ownerId, fileId);
    logEvent("template_deleted");
  }

  // ---- Importación ----

  async analyze(ownerId: string, fileName: string, bytes: Buffer, ocrEnabled = true): Promise<ImportAnalysis> {
    const safeName = stripControl(fileName).replace(/[\\/]/g, "_").slice(0, 120) || "plantilla";
    const kind = detectKind(safeName, bytes);
    const base = safeName.replace(/\.[^.]+$/, "");
    let res: { candidates: ImportAnalysis["candidates"]; warnings: string[]; sheets?: string[]; ocr?: boolean };
    const validTargets = new Set<string>();
    if (kind === "pdf") {
      res = await analyzePdf(bytes, ocrEnabled);
    } else {
      const zip = await openOfficeZip(bytes, kind);
      res = kind === "docx" ? await analyzeDocx(zip) : await analyzeXlsx(zip);
    }
    for (const c of res.candidates) if (c.target && c.target.kind !== "cell") validTargets.add(targetKey(c.target));
    const file = await this.store.putFile({ ownerId, kind, fileName: safeName, bytes });
    const analysis: ImportAnalysis = {
      importId: `imp_${randomUUID()}`,
      fileName: safeName,
      kind,
      suggestedName: base.slice(0, 80),
      candidates: res.candidates,
      sheets: res.sheets ?? [],
      warnings: [
        ...res.warnings,
        "La app propone campos; no promete conservar exactamente el diseño del archivo.",
      ],
      ocr: Boolean(res.ocr),
    };
    await this.store.putImport({ ownerId, fileId: file.id, analysis, validTargets }, IMPORT_TTL_MS);
    logEvent("template_import_analyzed", { kind, candidates: res.candidates.length });
    return analysis;
  }

  /** Crea la plantilla a partir de lo que el profesional confirmó o corrigió. */
  async confirmImport(ownerId: string, importId: string, body: unknown): Promise<TemplateDetail> {
    const imp = await this.store.getImport(ownerId, importId);
    if (!imp) throw new HttpError(404, "importacion_vencida", "La importación venció. Vuelve a subir el archivo.");
    const input = parse(templateInputSchema, body);
    const sections = normalizeSections(input.sections);
    const file = (await this.store.getFile(ownerId, imp.fileId))!;
    const source = { kind: file.kind, fileName: file.fileName, fileId: file.id, ocr: imp.analysis.ocr || undefined };
    for (const f of sections.flatMap((s) => s.fields)) {
      const t = f.target;
      if (t && t.kind !== "cell" && !imp.validTargets.has(targetKey(t)))
        throw new HttpError(400, "destino_invalido", `El destino del campo «${f.label}» no existe en el archivo.`);
    }
    await this.validateTargets(ownerId, source, sections);
    const now = Date.now();
    const rec: TemplateRecord = {
      id: `tpl_${randomUUID()}`,
      ownerId,
      name: stripControl(input.name),
      createdAt: now,
      updatedAt: now,
      source,
      versions: [{ version: 1, createdAt: now, note: `Importada de ${file.fileName}`, sections }],
    };
    await this.store.saveTemplate(rec);
    await this.store.deleteImport(ownerId, importId);
    logEvent("template_imported", { kind: file.kind });
    return this.detail(ownerId, rec.id);
  }

  /** Destinos coherentes con el archivo original: hoja y celda existentes y sin fórmula. */
  private async validateTargets(ownerId: string, source: TemplateRecord["source"], sections: TemplateSection[]) {
    const fields = sections.flatMap((s) => s.fields).filter((f) => f.target);
    if (!fields.length) return;
    if (!source) throw new HttpError(400, "sin_archivo", "Solo las plantillas importadas pueden tener destinos en un archivo.");
    const file = await this.store.getFile(ownerId, source.fileId);
    if (!file) throw new HttpError(410, "archivo_no_disponible", "El archivo original ya no está disponible.");
    if (file.kind === "pdf") throw new HttpError(400, "pdf_sin_destino", "Los PDF no admiten destinos: se exportan con el formato estándar.");
    const zip = await JSZip.loadAsync(file.bytes);
    const sheets = file.kind === "xlsx" ? (await sheetsOf(zip)).map((s) => s.name) : [];
    for (const f of fields) {
      const t = f.target!;
      if (file.kind === "xlsx") {
        if (t.kind !== "cell") throw new HttpError(400, "destino_invalido", `El campo «${f.label}» debe apuntar a una celda.`);
        if (!sheets.includes(t.sheet))
          throw new HttpError(400, "hoja_invalida", `La hoja «${t.sheet}» del campo «${f.label}» no existe.`);
        if (await cellHasFormula(zip, t.sheet, t.cell))
          throw new HttpError(400, "celda_formula", `La celda ${t.sheet}!${t.cell} tiene una fórmula y no se puede llenar.`);
      } else if (t.kind === "cell") {
        throw new HttpError(400, "destino_invalido", `El campo «${f.label}» no puede apuntar a una celda en un Word.`);
      }
    }
  }

  // ---- Exportación en el formato original ----

  async exportOriginal(ownerId: string, snap: InterviewSnapshot): Promise<{ bytes: Buffer; kind: "docx" | "xlsx"; missing: number }> {
    const src = snap.template.source;
    if (!src || src.kind === "pdf")
      throw new HttpError(400, "sin_original", "Esta plantilla no tiene un archivo Word o Excel para llenar.");
    const file = await this.store.getFile(ownerId, src.fileId);
    if (!file) throw new HttpError(410, "archivo_no_disponible", "El archivo original ya no está disponible.");
    const zip = await JSZip.loadAsync(file.bytes);
    const prefix = snap.demo ? "[DEMO] " : "";
    const mapped = allFields(snap.template).filter((f) => f.target);
    if (src.kind === "xlsx") {
      const res = await fillXlsx(
        zip,
        mapped
          .filter((f) => f.target!.kind === "cell")
          .map((f) => {
            const t = f.target as Extract<FieldTarget, { kind: "cell" }>;
            return { sheet: t.sheet, cell: t.cell, value: prefix + finalValue(snap.fields[f.id]) };
          }),
      );
      const bytes = await pack(zip);
      return { bytes, kind: "xlsx", missing: res.skipped.length };
    }
    const res = await fillDocx(
      zip,
      mapped
        .filter((f) => f.target!.kind !== "cell")
        .map((f) => ({
          target: f.target as Exclude<FieldTarget, { kind: "cell" }>,
          value: prefix + finalValue(snap.fields[f.id]),
        })),
    );
    if (snap.demo) {
      // Marca visible al inicio del cuerpo: documento con datos ficticios.
      const doc = await zip.file("word/document.xml")!.async("string");
      const banner = `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(
        "DOCUMENTO DE DEMOSTRACIÓN — DATOS FICTICIOS",
      )}</w:t></w:r></w:p>`;
      zip.file("word/document.xml", doc.replace(/(<w:body\b[^>]*>)/, `$1${banner}`));
    }
    const bytes = await pack(zip);
    return { bytes, kind: "docx", missing: res.missing.length };
  }
}

/** Sin entradas de carpeta: Word puede rechazar el archivo en servicios en la nube (skill docx). */
async function pack(zip: JSZip): Promise<Buffer> {
  // Se copian solo archivos: `remove` de una carpeta en JSZip borra también su contenido.
  const out = new JSZip();
  for (const [name, f] of Object.entries(zip.files)) {
    if (f.dir) continue;
    out.file(name, await f.async("uint8array"), { createFolders: false, date: f.date });
  }
  return out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function targetKey(t: FieldTarget) {
  return t.kind === "bookmark" ? `bm:${t.name}` : t.kind === "paragraph" ? `p:${t.index}:${t.text}` : `c:${t.sheet}!${t.cell}`;
}
