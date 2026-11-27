/**
 * Etapa 2: plantillas propias. Importación segura, confirmación, versionado,
 * separación entre profesionales, extracción en campos propios y exportación
 * en el formato original. Archivos ficticios en tests/fixtures.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import JSZip from "jszip";
import type { ImportAnalysis, InterviewSnapshot, TemplateDetail } from "../../shared/types";
import { suggestConcept } from "../../shared/concepts";
import { type App, createApp } from "../../server/app";
import { loadConfig } from "../../server/config";
import { setLogSink } from "../../server/log";
import { ocrAvailable } from "../../server/templates/pdf";

const fx = (n: string) => readFileSync(`tests/fixtures/${n}`);
const logs: string[] = [];
let app: App;
let base: string;

before(async () => {
  setLogSink((l) => logs.push(l));
  app = createApp(loadConfig({ DEMO_SPEED: "100", STATIC_DIR: "public" }));
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => app.close());

class Client {
  cookie = "";
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": isBuf ? "application/octet-stream" : "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isBuf ? new Uint8Array(body as Buffer) : JSON.stringify(body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    return res;
  }
  async json<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const r = await this.req(method, path, body, headers);
    return { status: r.status, body: (await r.json()) as T & { error?: string; message?: string } };
  }
  upload(name: string, bytes: Buffer) {
    return this.json<ImportAnalysis>("POST", "/api/templates/import", bytes, { "X-File-Name": encodeURIComponent(name) });
  }
}

async function login(perfil: "demo-a" | "demo-b") {
  const c = new Client();
  await c.req("POST", "/api/demo/session", { perfil });
  return c;
}

/** Agrupa candidatos incluidos por sección, como lo hace la interfaz. */
function bodyFrom(a: ImportAnalysis, edit?: (f: Record<string, unknown>) => void) {
  const sections: { title: string; fields: Record<string, unknown>[] }[] = [];
  for (const c of a.candidates.filter((x) => x.include)) {
    let s = sections.find((x) => x.title === c.section);
    if (!s) sections.push((s = { title: c.section, fields: [] }));
    const f: Record<string, unknown> = { label: c.label, concept: c.concept, target: c.target };
    edit?.(f);
    s.fields.push(f);
  }
  return { name: a.suggestedName, sections };
}

async function finishInterview(c: Client, templateId: string) {
  const { body: s } = await c.json<InterviewSnapshot>("POST", "/api/interviews", { templateId });
  const id = s.id;
  await c.json("POST", `/api/interviews/${id}/consent`, { givenBy: "paciente" });
  await c.json("POST", `/api/interviews/${id}/command`, { command: "iniciar" });
  for (let i = 0; i < 100; i++) {
    const { body } = await c.json<InterviewSnapshot>("GET", `/api/interviews/${id}`);
    if (body.status === "detenida") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const [speaker, role] of [[1, "profesional"], [2, "paciente"], [3, "acompanante"]] as const)
    await c.json("POST", `/api/interviews/${id}/speakers`, { speaker, role });
  return id;
}

describe("tipos de dato sugeridos", () => {
  it("sugiere por etiqueta y prioriza familiares", () => {
    assert.equal(suggestConcept("Fármacos en uso"), "medicamentos");
    assert.equal(suggestConcept("Hábito tabáquico"), "tabaco");
    assert.equal(suggestConcept("Antecedentes mórbidos familiares"), "familiares");
    assert.equal(suggestConcept("RAM"), "alergias");
    assert.equal(suggestConcept("Firma"), undefined);
  });
});

describe("importación segura", () => {
  it("rechaza macros, formatos antiguos y extensiones que no coinciden con el contenido", async () => {
    const c = await login("demo-a");
    let r = await c.upload("ficha-con-macros-demo.xlsm", fx("ficha-con-macros-demo.xlsm"));
    assert.equal(r.body.error, "macros");
    // Mismo contenido con macros, pero renombrado a .xlsx: también se rechaza.
    r = await c.upload("ficha.xlsx", fx("ficha-con-macros-demo.xlsm"));
    assert.equal(r.body.error, "macros");
    r = await c.upload("ficha.doc", Buffer.from("abc"));
    assert.equal(r.body.error, "formato_antiguo");
    r = await c.upload("ficha.docx", fx("ficha-demo.pdf"));
    assert.equal(r.body.error, "tipo_no_soportado");
    r = await c.upload("vacio.pdf", Buffer.alloc(0));
    assert.equal(r.status, 400);
  });

  it("rechaza paquetes con demasiadas partes", async () => {
    const c = await login("demo-a");
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document/>", { createFolders: false });
    for (let i = 0; i < 1500; i++) zip.file(`parte-${i}.xml`, "<parte/>");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const r = await c.upload("muchas-partes.docx", bytes);
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "archivo_complejo");
  });

  it("rechaza archivos de más de 5 MB", async () => {
    const c = await login("demo-a");
    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(5 * 1024 * 1024 + 10)]);
    const r = await c.req("POST", "/api/templates/import", big, { "X-File-Name": "grande.pdf" });
    assert.equal(r.status, 413);
  });
});

describe("Word con marcadores y etiquetas", () => {
  let c: Client;
  let tpl: TemplateDetail;

  it("propone campos, secciones y tipos de dato", async () => {
    c = await login("demo-a");
    const { body: a } = await c.upload("ficha-demo.docx", fx("ficha-demo.docx"));
    assert.equal(a.kind, "docx");
    const byLabel = Object.fromEntries(a.candidates.map((x) => [x.label, x]));
    assert.deepEqual(byLabel["Motivo de consulta"].target, { kind: "bookmark", name: "motivo_consulta" });
    assert.equal(byLabel["Fármacos en uso"].concept, "medicamentos");
    assert.equal(byLabel["Alergias"].target?.kind, "paragraph");
    assert.equal(byLabel["Antecedentes familiares"].section, "Antecedentes");
    assert.ok(a.warnings.some((w) => /no promete conservar/.test(w)));

    // El profesional corrige: «Observaciones» solo del profesional.
    const body = bodyFrom(a, (f) => {
      if (f.label === "Observaciones del profesional") {
        f.manualOnly = true;
        f.concept = null;
      }
    });
    const r = await c.json<TemplateDetail>("POST", `/api/templates/import/${a.importId}/confirm`, body);
    assert.equal(r.status, 201, r.body.message ?? "");
    tpl = r.body;
    assert.equal(tpl.version, 1);
    const fields = tpl.sections.flatMap((s) => s.fields);
    assert.ok(fields.find((f) => f.concept === "medicamentos")?.critical, "medicamentos siempre crítico");
    // Una importación confirmada no se puede reutilizar.
    const again = await c.json("POST", `/api/templates/import/${a.importId}/confirm`, body);
    assert.equal(again.status, 404);
  });

  it("no acepta destinos inventados que no existen en el archivo", async () => {
    const { body: a } = await c.upload("ficha-demo.docx", fx("ficha-demo.docx"));
    const body = bodyFrom(a);
    body.sections[0].fields[0].target = { kind: "bookmark", name: "inventado" };
    const r = await c.json("POST", `/api/templates/import/${a.importId}/confirm`, body);
    assert.equal(r.body.error, "destino_invalido");
  });

  it("llena el campo propio con la extracción y exporta en el formato original", async () => {
    const id = await finishInterview(c, tpl.id);
    let { body: s } = await c.json<InterviewSnapshot>("GET", `/api/interviews/${id}`);
    const med = tpl.sections.flatMap((x) => x.fields).find((f) => f.concept === "medicamentos")!;
    assert.equal(s.fields[med.id].status, "requiere_revision");
    assert.ok(s.fields[med.id].items.length >= 2);
    const tabaco = tpl.sections.flatMap((x) => x.fields).find((f) => f.label === "Hábito tabáquico")!;
    assert.equal(s.fields[tabaco.id].items.length, 2, "tabaco: histórico y negación");

    // Corrección del profesional: no se sobrescribe y llega al archivo.
    const mine = "Metformina 850 mg (frecuencia a confirmar) [texto del profesional]";
    await c.json("POST", `/api/interviews/${id}/fields/${med.id}/confirm`, { value: mine });
    for (const f of Object.values(s.fields).filter((x) => x.status === "requiere_revision" && x.fieldId !== med.id))
      await c.json("POST", `/api/interviews/${id}/fields/${f.fieldId}/confirm`, { value: null });
    const fin = await c.json<InterviewSnapshot>("POST", `/api/interviews/${id}/finalize`, { attested: true });
    assert.equal(fin.status, 200, fin.body.message ?? "");
    s = fin.body;

    const r = await c.req("GET", `/api/interviews/${id}/export?format=original`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition") ?? "", /formato-original\.docx/);
    const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
    assert.ok(!Object.values(zip.files).some((f) => f.dir), "sin entradas de carpeta");
    const xml = await zip.file("word/document.xml")!.async("string");
    assert.match(xml, /DATOS FICTICIOS/);
    assert.match(xml, /texto del profesional/);
    assert.match(xml, /\[DEMO\] Refiere «Vengo porque/);
  });

  it("bloquea el formato original si un destino guardado no existe", async () => {
    const { body: session } = await c.json<{ professional: { id: string } }>("GET", "/api/session");
    const { body: snap } = await c.json<InterviewSnapshot>("POST", "/api/interviews", { templateId: tpl.id });
    const saved = await app.store.getInterview(session.professional.id, snap.id);
    assert.ok(saved);
    const field = saved.template.sections.flatMap((section) => section.fields).find((f) => f.target);
    assert.ok(field);
    field.target = { kind: "bookmark", name: "marcador_inexistente" };
    saved.status = "finalizada";
    await app.store.saveInterview(saved);

    const path = `/api/interviews/${snap.id}/export?format=`;
    const original = await c.req("GET", path + "original");
    assert.equal(original.status, 409);
    assert.equal(original.headers.get("content-disposition"), null);
    const error = await original.json();
    assert.equal(error.error, "exportacion_incompleta");
    assert.match(error.message, /formato estándar/);
    const standard = await c.req("GET", path + "docx");
    assert.equal(standard.status, 200);
    await standard.arrayBuffer();
  });

  it("versiona: la entrevista anterior conserva su versión", async () => {
    const { body: d } = await c.json<TemplateDetail>("GET", `/api/templates/${tpl.id}`);
    const sections = d.sections.map((s) => ({ ...s }));
    sections[0] = { ...sections[0], fields: [...sections[0].fields, { id: "peso", label: "Peso" }] };
    let r = await c.json<TemplateDetail>("PUT", `/api/templates/${tpl.id}`, { name: d.name, sections, baseVersion: 1, note: "Agrega peso" });
    assert.equal(r.status, 200, r.body.message ?? "");
    assert.equal(r.body.version, 2);
    assert.equal(r.body.versions.length, 2);
    // Guardar sobre una versión vieja se rechaza (no pisa cambios).
    r = await c.json<TemplateDetail>("PUT", `/api/templates/${tpl.id}`, { name: d.name, sections, baseVersion: 1 });
    assert.equal(r.body.error, "version_desactualizada");
    const v1 = await c.json<TemplateDetail>("GET", `/api/templates/${tpl.id}?version=1`);
    assert.ok(!v1.body.sections.flatMap((s) => s.fields).some((f) => f.label === "Peso"));
    const list = await c.json<InterviewSnapshot[]>("GET", "/api/interviews");
    const old = await c.json<InterviewSnapshot>("GET", `/api/interviews/${(list.body as unknown as { id: string }[])[0].id}`);
    assert.equal(old.body.template.version, 1);
  });

  it("otro profesional no ve ni usa la plantilla ni su archivo", async () => {
    const b = await login("demo-b");
    const list = await b.json<{ id: string }[]>("GET", "/api/templates");
    assert.ok(!(list.body as unknown as { id: string }[]).some((t) => t.id === tpl.id));
    assert.equal((await b.req("GET", `/api/templates/${tpl.id}`)).status, 404);
    assert.equal((await b.req("PUT", `/api/templates/${tpl.id}`, { name: "x", sections: [] })).status, 404);
    assert.equal((await b.req("DELETE", `/api/templates/${tpl.id}`)).status, 404);
    assert.equal((await b.req("POST", "/api/interviews", { templateId: tpl.id })).status, 404);
  });
});

describe("Excel con hoja y celda", () => {
  it("mapea celdas, protege fórmulas y escribe valores como texto", async () => {
    const c = await login("demo-b");
    const { body: a } = await c.upload("ficha-demo.xlsx", fx("ficha-demo.xlsx"));
    assert.deepEqual(a.sheets, ["Ingreso", "Antecedentes"]);
    const formula = a.candidates.find((x) => x.label === "Puntaje calculado")!;
    assert.equal(formula.include, false);
    assert.match(formula.problem ?? "", /fórmula/);
    assert.ok(a.candidates.some((x) => x.origin === "nombre_definido" && x.concept === "alcohol"));

    // Intentar mapear la celda con fórmula se rechaza.
    const bad = bodyFrom(a);
    bad.sections[0].fields[0].target = { kind: "cell", sheet: "Ingreso", cell: "B6" };
    assert.equal((await c.json("POST", `/api/templates/import/${a.importId}/confirm`, bad)).body.error, "celda_formula");
    // Hoja inexistente.
    bad.sections[0].fields[0].target = { kind: "cell", sheet: "NoExiste", cell: "B6" };
    assert.equal((await c.json("POST", `/api/templates/import/${a.importId}/confirm`, bad)).body.error, "hoja_invalida");

    const r = await c.json<TemplateDetail>("POST", `/api/templates/import/${a.importId}/confirm`, bodyFrom(a));
    assert.equal(r.status, 201, r.body.message ?? "");
    const id = await finishInterview(c, r.body.id);
    const { body: s } = await c.json<InterviewSnapshot>("GET", `/api/interviews/${id}`);
    for (const f of Object.values(s.fields).filter((x) => x.status === "requiere_revision"))
      await c.json("POST", `/api/interviews/${id}/fields/${f.fieldId}/confirm`, { value: null });
    assert.equal((await c.json("POST", `/api/interviews/${id}/finalize`, { attested: true })).status, 200);

    const out = await c.req("GET", `/api/interviews/${id}/export?format=original`);
    assert.equal(out.status, 200);
    const zip = await JSZip.loadAsync(Buffer.from(await out.arrayBuffer()));
    const sheet1 = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    assert.match(sheet1, /<c r="B3"[^>]*t="inlineStr"><is><t xml:space="preserve">\[DEMO\] Refiere/);
    assert.match(sheet1, /<c r="B6"[^>]*><f>LEN\(B3\)<\/f>/, "la fórmula queda intacta");
    const sheet2 = await zip.file("xl/worksheets/sheet2.xml")!.async("string");
    assert.match(sheet2, /<c r="B4"[^>]*t="inlineStr"><is><t xml:space="preserve">\[DEMO\] Responde «Una vez al mes»/);
  });
});

describe("PDF", () => {
  it("propone campos desde el texto, sin destinos", async () => {
    const c = await login("demo-a");
    const { body: a } = await c.upload("ficha-demo.pdf", fx("ficha-demo.pdf"));
    assert.equal(a.kind, "pdf");
    assert.deepEqual(
      a.candidates.map((x) => x.label),
      ["Motivo de consulta", "Alergias", "Antecedentes quirúrgicos"],
    );
    assert.ok(a.candidates.every((x) => x.target === null));
    const body = bodyFrom(a);
    body.sections[0].fields.push({ label: "Campo agregado a mano" });
    const r = await c.json<TemplateDetail>("POST", `/api/templates/import/${a.importId}/confirm`, body);
    assert.equal(r.status, 201, r.body.message ?? "");
    assert.equal(r.body.source?.kind, "pdf");
  });

  it("escaneo: usa OCR si existe y siempre pide revisión; sin OCR, campos manuales", async (t) => {
    const c = await login("demo-a");
    const { body: a } = await c.upload("ficha-escaneada-demo.pdf", fx("ficha-escaneada-demo.pdf"));
    if (!(await ocrAvailable())) {
      assert.equal(a.candidates.length, 0);
      assert.ok(a.warnings.some((w) => /Crea los campos a mano/.test(w)));
      t.diagnostic("OCR no disponible en este entorno");
      return;
    }
    assert.equal(a.ocr, true);
    assert.ok(a.candidates.some((x) => x.concept === "alergias" && x.origin === "ocr"));
    assert.ok(a.warnings.some((w) => /OCR/.test(w) && /Revisa cada uno/.test(w)));
  });
});

describe("plantilla predeterminada y edición", () => {
  it("la predeterminada no se edita, pero se puede duplicar", async () => {
    const c = await login("demo-a");
    const r = await c.json("PUT", "/api/templates/generica", { name: "x", sections: [{ title: "x", fields: [] }], baseVersion: 1 });
    assert.equal(r.body.error, "predeterminada");
    const d = await c.json<TemplateDetail>("POST", "/api/templates", { fromId: "generica" });
    assert.equal(d.status, 201);
    assert.equal(d.body.builtIn, false);
    assert.ok(d.body.name.includes("(copia)"));
  });

  it("valida nombres, límites y no permite destinos sin archivo", async () => {
    const c = await login("demo-a");
    let r = await c.json("POST", "/api/templates", { name: "", sections: [{ title: "A", fields: [] }] });
    assert.equal(r.status, 400);
    r = await c.json("POST", "/api/templates", {
      name: "Con destino",
      sections: [{ title: "A", fields: [{ label: "X", target: { kind: "cell", sheet: "H", cell: "A1" } }] }],
    });
    assert.equal(r.status, 201); // al crear sin archivo el destino no se valida contra nada...
    const created = r.body as unknown as TemplateDetail;
    const upd = await c.json("PUT", `/api/templates/${created.id}`, { ...created, baseVersion: 1 });
    assert.equal(upd.body.error, "sin_archivo"); // ...pero no se puede guardar ni exportar con él
  });

  it("los registros no contienen nombres de archivo ni etiquetas", () => {
    const all = logs.join("\n");
    assert.ok(!all.includes("ficha-demo"));
    assert.ok(!all.includes("Fármacos"));
    assert.ok(all.includes("template_imported"));
  });
});
