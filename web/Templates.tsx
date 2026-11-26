import { useEffect, useRef, useState } from "react";
import { CONCEPTS, conceptInfo } from "../shared/concepts";
import type {
  FieldTarget,
  ImportAnalysis,
  TemplateDetail,
  TemplateSummary,
} from "../shared/types";
import { api, ApiError, type TemplateBody } from "./api";

/** Campo en edición (plantilla propia o propuesta de importación). */
interface EditField {
  key: string;
  id?: string;
  label: string;
  hint?: string;
  concept: string | null;
  critical: boolean;
  manualOnly: boolean;
  target: FieldTarget | null;
  include: boolean;
  problem?: string;
  origin?: string;
}
interface EditSection {
  key: string;
  id?: string;
  title: string;
  fields: EditField[];
}

let seq = 0;
const k = () => `k${++seq}`;

function toBody(name: string, sections: EditSection[]): TemplateBody {
  return {
    name,
    sections: sections
      .map((s) => ({
        id: s.id,
        title: s.title,
        fields: s.fields
          .filter((f) => f.include)
          .map((f) => ({
            id: f.id,
            label: f.label,
            hint: f.hint || undefined,
            concept: f.manualOnly ? null : f.concept,
            critical: f.critical,
            manualOnly: f.manualOnly,
            target: f.target,
          })),
      }))
      .filter((s) => s.fields.length > 0),
  };
}

function targetText(t: FieldTarget | null) {
  if (!t) return "Sin destino: se exporta en el formato estándar";
  if (t.kind === "bookmark") return `Marcador de Word «${t.name}»`;
  if (t.kind === "paragraph") return `Al final de la línea «${t.text}»`;
  return `Hoja «${t.sheet}», celda ${t.cell}`;
}

export function TemplatesScreen({
  onBack,
  onOpen,
  onImported,
}: {
  onBack: () => void;
  onOpen: (id: string) => void;
  onImported: (a: ImportAnalysis) => void;
}) {
  const [list, setList] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.templates().then(setList, (e: ApiError) => setError(e.message));
  }, []);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onImported(await api.importFile(file));
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const createEmpty = () =>
    api
      .createTemplate({ name: "Plantilla nueva", sections: [{ title: "General", fields: [{ label: "Motivo de consulta", concept: "motivo" }] }] })
      .then((t) => onOpen(t.id), (e: ApiError) => setError(e.message));

  return (
    <main className="templates">
      <button className="link back" onClick={onBack}>
        Entrevistas
      </button>
      <h1>Plantillas</h1>
      <p className="muted">
        Usa la plantilla general o crea las tuyas. Puedes importar un Word, Excel o PDF: la app propone
        los campos y tú confirmas cada uno antes de usarla.
      </p>

      <div className="stack">
        <label className={`btn primary ${busy ? "disabled" : ""}`}>
          {busy ? "Analizando archivo…" : "Importar Word, Excel o PDF"}
          <input
            ref={fileRef}
            type="file"
            className="sr-only"
            accept=".docx,.xlsx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy}
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </label>
        <button className="btn" onClick={createEmpty}>
          Crear plantilla vacía
        </button>
      </div>
      <p className="muted small">
        En iPhone se abre la app Archivos. Máximo 5 MB. No se aceptan archivos con macros. Sube
        formularios en blanco, nunca documentos con datos de pacientes.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {list === null ? (
        <p className="muted">Cargando…</p>
      ) : (
        <ul className="interview-list">
          {list.map((t) => (
            <li key={t.id}>
              <button className="row-btn" onClick={() => onOpen(t.id)}>
                <span>
                  {t.name}
                  <span className="muted small block">
                    {t.builtIn ? "Predeterminada" : `Versión ${t.version}`}, {t.fieldCount} campos
                    {t.sourceKind ? `, importada de ${t.sourceKind.toUpperCase()}` : ""}
                  </span>
                </span>
                <span className="pill">Abrir</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function fromDetail(t: TemplateDetail): EditSection[] {
  return t.sections.map((s) => ({
    key: k(),
    id: s.id,
    title: s.title,
    fields: s.fields.map((f) => ({
      key: k(),
      id: f.id,
      label: f.label,
      hint: f.hint,
      concept: f.concept ?? null,
      critical: Boolean(f.critical),
      manualOnly: Boolean(f.manualOnly),
      target: f.target ?? null,
      include: true,
    })),
  }));
}

function fromAnalysis(a: ImportAnalysis): EditSection[] {
  const sections: EditSection[] = [];
  for (const c of a.candidates) {
    let s = sections.find((x) => x.title === c.section);
    if (!s) {
      s = { key: k(), title: c.section, fields: [] };
      sections.push(s);
    }
    s.fields.push({
      key: k(),
      label: c.label,
      concept: c.concept,
      critical: Boolean(conceptInfo(c.concept ?? undefined)?.critical),
      manualOnly: false,
      target: c.target,
      include: c.include,
      problem: c.problem,
      origin: c.origin,
    });
  }
  if (!sections.length) sections.push({ key: k(), title: "General", fields: [] });
  return sections;
}

export function TemplateEditorScreen({
  id,
  analysis,
  onBack,
  onSaved,
}: {
  id?: string;
  analysis?: ImportAnalysis;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [name, setName] = useState(analysis?.suggestedName ?? "");
  const [sections, setSections] = useState<EditSection[]>(analysis ? fromAnalysis(analysis) : []);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = (v?: number) =>
    api.template(id!, v).then(
      (t) => {
        setDetail(t);
        setName(t.name);
        setSections(fromDetail(t));
        setViewVersion(v && v !== t.versions[t.versions.length - 1]?.version ? v : null);
      },
      (e: ApiError) => setError(e.message),
    );

  useEffect(() => {
    if (id) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const isImport = Boolean(analysis);
  const builtIn = detail?.builtIn ?? false;
  const readOnly = builtIn || viewVersion !== null;
  const kind = analysis?.kind ?? detail?.source?.kind ?? null;
  const sheets = analysis?.sheets ?? [];
  const latest = detail?.versions[detail.versions.length - 1]?.version;

  const update = (sk: string, fk: string, patch: Partial<EditField>) =>
    setSections((ss) =>
      ss.map((s) => (s.key !== sk ? s : { ...s, fields: s.fields.map((f) => (f.key === fk ? { ...f, ...patch } : f)) })),
    );
  const move = (sk: string, fk: string, d: -1 | 1) =>
    setSections((ss) =>
      ss.map((s) => {
        if (s.key !== sk) return s;
        const i = s.fields.findIndex((f) => f.key === fk);
        const j = i + d;
        if (j < 0 || j >= s.fields.length) return s;
        const fields = [...s.fields];
        [fields[i], fields[j]] = [fields[j], fields[i]];
        return { ...s, fields };
      }),
    );
  const remove = (sk: string, fk: string) =>
    setSections((ss) => ss.map((s) => (s.key !== sk ? s : { ...s, fields: s.fields.filter((f) => f.key !== fk) })));
  const addField = (sk: string) =>
    setSections((ss) =>
      ss.map((s) =>
        s.key !== sk
          ? s
          : {
              ...s,
              fields: [
                ...s.fields,
                { key: k(), label: "", concept: null, critical: false, manualOnly: false, target: null, include: true },
              ],
            },
      ),
    );

  const save = async () => {
    setError(null);
    setSaved(null);
    try {
      const body = toBody(name, sections);
      if (isImport) {
        const t = await api.confirmImport(analysis!.importId, body);
        onSaved(t.id);
      } else {
        const t = await api.saveTemplate(id!, { ...body, note: note || undefined, baseVersion: latest });
        setDetail(t);
        setSections(fromDetail(t));
        setNote("");
        setSaved(`Guardada como versión ${t.version}. Las entrevistas anteriores conservan su versión.`);
      }
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  if (id && !detail && !error) return <main className="center muted">Cargando…</main>;

  return (
    <main className="editor">
      <button className="link back" onClick={onBack}>
        Plantillas
      </button>
      <h1>{isImport ? "Revisar campos detectados" : builtIn ? detail?.name : "Editar plantilla"}</h1>

      {isImport && (
        <>
          <p className="muted">
            De <strong>{analysis!.fileName}</strong>. Revisa cada propuesta: corrige el nombre, elige el tipo
            de dato y desmarca lo que no sea un campo. Nada se usa hasta que confirmes.
          </p>
          <ul className="warnings">
            {analysis!.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      )}
      {builtIn && <p className="muted">La plantilla predeterminada no se edita. Duplícala para adaptarla.</p>}
      {viewVersion !== null && (
        <p className="banner">
          Estás viendo la versión {viewVersion} (solo lectura).{" "}
          <button className="link" onClick={() => load()}>
            Volver a la última
          </button>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="ok" role="status">
          {saved}
        </p>
      )}

      <label className="field-label" htmlFor="tpl-name">
        Nombre de la plantilla
      </label>
      <input id="tpl-name" type="text" value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} />

      {sections.map((s) => (
        <section key={s.key} className="draft-section">
          {readOnly ? (
            <h2>{s.title}</h2>
          ) : (
            <div className="section-title">
              <label className="sr-only" htmlFor={`sec-${s.key}`}>
                Título de la sección
              </label>
              <input
                id={`sec-${s.key}`}
                type="text"
                value={s.title}
                onChange={(e) => setSections((ss) => ss.map((x) => (x.key === s.key ? { ...x, title: e.target.value } : x)))}
              />
            </div>
          )}
          {s.fields.map((f, i) => (
            <FieldEditor
              key={f.key}
              f={f}
              readOnly={readOnly}
              isImport={isImport}
              kind={kind}
              sheets={sheets}
              first={i === 0}
              last={i === s.fields.length - 1}
              onChange={(patch) => update(s.key, f.key, patch)}
              onMove={(d) => move(s.key, f.key, d)}
              onRemove={() => remove(s.key, f.key)}
            />
          ))}
          {!readOnly && (
            <button className="btn small" onClick={() => addField(s.key)}>
              Agregar campo
            </button>
          )}
        </section>
      ))}

      {!readOnly && (
        <button
          className="btn small quiet"
          onClick={() => setSections((ss) => [...ss, { key: k(), title: "Sección nueva", fields: [] }])}
        >
          Agregar sección
        </button>
      )}

      {!readOnly && !isImport && (
        <>
          <label className="field-label" htmlFor="tpl-note">
            Nota de esta versión (opcional)
          </label>
          <input id="tpl-note" type="text" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </>
      )}

      <div className="actions sticky-actions">
        {!readOnly && (
          <button className="btn primary" onClick={save}>
            {isImport ? "Confirmar y crear plantilla" : "Guardar nueva versión"}
          </button>
        )}
        {detail && (
          <button
            className="btn"
            onClick={() => api.duplicateTemplate(detail.id).then((t) => onSaved(t.id), (e: ApiError) => setError(e.message))}
          >
            Duplicar
          </button>
        )}
        {detail && !builtIn && (
          <button
            className="btn danger"
            onClick={() => {
              if (window.confirm("¿Eliminar esta plantilla? Las entrevistas ya hechas conservan su copia."))
                api.deleteTemplate(detail.id).then(onBack, (e: ApiError) => setError(e.message));
            }}
          >
            Eliminar
          </button>
        )}
      </div>

      {detail && !builtIn && (
        <section aria-labelledby="versiones">
          <h2 id="versiones">Versiones</h2>
          <ol className="versions">
            {[...detail.versions].reverse().map((v) => (
              <li key={v.version}>
                <button className="link" onClick={() => load(v.version)}>
                  Versión {v.version}
                </button>{" "}
                <span className="muted small">
                  {new Date(v.createdAt).toLocaleString("es-CL")}, {v.note}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}

function FieldEditor({
  f,
  readOnly,
  isImport,
  kind,
  sheets,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  f: EditField;
  readOnly: boolean;
  isImport: boolean;
  kind: string | null;
  sheets: string[];
  first: boolean;
  last: boolean;
  onChange: (p: Partial<EditField>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  const info = conceptInfo(f.concept ?? undefined);
  const forcedCritical = Boolean(info?.critical);
  const id = `f-${f.key}`;
  return (
    <article className={`tpl-field ${f.include ? "" : "excluded"}`}>
      {isImport && (
        <label className="check">
          <input type="checkbox" checked={f.include} onChange={(e) => onChange({ include: e.target.checked })} />
          Usar como campo
          {f.origin === "ocr" && <span className="tag warn-tag">Leído por OCR: revisar</span>}
        </label>
      )}
      {f.problem && <p className="error small">{f.problem}</p>}
      <div className="grid2">
        <div>
          <label className="field-label" htmlFor={`${id}-label`}>
            Nombre del campo
          </label>
          <input
            id={`${id}-label`}
            type="text"
            value={f.label}
            disabled={readOnly}
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </div>
        <div>
          <label className="field-label" htmlFor={`${id}-concept`}>
            Tipo de dato
          </label>
          <select
            id={`${id}-concept`}
            value={f.manualOnly ? "__manual" : (f.concept ?? "")}
            disabled={readOnly}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__manual") onChange({ manualOnly: true, concept: null });
              else
                onChange({
                  manualOnly: false,
                  concept: v || null,
                  critical: Boolean(conceptInfo(v)?.critical) || (f.critical && !conceptInfo(f.concept ?? undefined)?.critical),
                });
            }}
          >
            <option value="">Sin tipo (se completa a mano)</option>
            <option value="__manual">Solo del profesional (nunca se propone)</option>
            {CONCEPTS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={f.critical || forcedCritical}
          disabled={readOnly || forcedCritical}
          onChange={(e) => onChange({ critical: e.target.checked })}
        />
        Revisión obligatoria{forcedCritical ? " (siempre en medicamentos y alergias)" : ""}
      </label>

      {kind === "xlsx" && !readOnly ? (
        <div className="grid2">
          <div>
            <label className="field-label" htmlFor={`${id}-sheet`}>
              Hoja
            </label>
            <select
              id={`${id}-sheet`}
              value={f.target?.kind === "cell" ? f.target.sheet : ""}
              onChange={(e) =>
                onChange({
                  target: e.target.value
                    ? { kind: "cell", sheet: e.target.value, cell: f.target?.kind === "cell" ? f.target.cell : "B1" }
                    : null,
                })
              }
            >
              <option value="">Sin destino</option>
              {(sheets.length ? sheets : f.target?.kind === "cell" ? [f.target.sheet] : []).map((sh) => (
                <option key={sh} value={sh}>
                  {sh}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor={`${id}-cell`}>
              Celda
            </label>
            <input
              id={`${id}-cell`}
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              placeholder="B5"
              value={f.target?.kind === "cell" ? f.target.cell : ""}
              disabled={f.target?.kind !== "cell"}
              onChange={(e) =>
                f.target?.kind === "cell" &&
                onChange({ target: { ...f.target, cell: e.target.value.toUpperCase().replace(/\s/g, "") } })
              }
            />
          </div>
        </div>
      ) : (
        kind && kind !== "pdf" && <p className="muted small">Destino: {targetText(f.target)}</p>
      )}

      {!readOnly && (
        <div className="actions">
          <button className="btn small quiet" disabled={first} onClick={() => onMove(-1)} aria-label={`Subir ${f.label}`}>
            Subir
          </button>
          <button className="btn small quiet" disabled={last} onClick={() => onMove(1)} aria-label={`Bajar ${f.label}`}>
            Bajar
          </button>
          {!isImport && (
            <button className="btn small quiet" onClick={onRemove} aria-label={`Quitar ${f.label}`}>
              Quitar
            </button>
          )}
        </div>
      )}
    </article>
  );
}
