import { useEffect, useMemo, useRef, useState } from "react";
import {
  CLASSIFICATION_LABEL,
  REASON_LABEL,
  ROLE_LABEL,
  STATUS_LABEL,
  type FieldState,
  type InterviewSnapshot,
  type ProposalItem,
  type SessionInfo,
  type SpeakerRole,
  type TemplateField,
} from "../shared/types";
import { api, ApiError } from "./api";
import { DemoNotice, STATUS_TEXT } from "./App";
import { type Connection, useInterview } from "./useInterview";

type Tab = "entrevista" | "anamnesis" | "finalizar";

export function InterviewScreen({
  id,
  session,
  onExit,
}: {
  id: string;
  session: SessionInfo;
  onExit: () => void;
}) {
  const { snap, interim, conn, apply } = useInterview(id, onExit);
  const [tab, setTab] = useState<Tab>("entrevista");
  const [error, setError] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  const run = (p: Promise<InterviewSnapshot>) =>
    p.then(
      (s) => {
        setError(null);
        apply(s);
      },
      (e: ApiError) => setError(e.message),
    );

  const fields = snap?.fields ?? {};
  const pending = useMemo(
    () => Object.values(fields).filter((f) => f.status === "requiere_revision").length,
    [fields],
  );

  if (!snap)
    return (
      <main className="center muted">
        {conn === "sin_conexion" ? "Sin conexión. Se reintentará automáticamente." : "Conectando…"}
      </main>
    );

  const jumpTo = (segmentId: string) => {
    setHighlight(segmentId);
    setTab("entrevista");
  };

  const start = () => (snap.consent ? run(api.command(id, "iniciar")) : setConsentOpen(true));

  return (
    <div className="interview">
      <header className="topbar">
        <button className="link back" onClick={onExit}>
          Entrevistas
        </button>
        <div className="indicators" aria-live="polite">
          <ListeningIndicator status={snap.status} />
          <ConnectionIndicator conn={conn} />
        </div>
      </header>
      <h1 className="interview-title">{snap.title}</h1>
      {snap.demo && <DemoNotice />}
      {snap.status === "pausada" && snap.pauseReason && <PauseBanner reason={snap.pauseReason} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <nav className="tabs" role="tablist" aria-label="Secciones de la entrevista">
        {(["entrevista", "anamnesis", "finalizar"] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "tab active" : "tab"}
            onClick={() => setTab(t)}
          >
            {t === "entrevista" ? "Entrevista" : t === "anamnesis" ? "Anamnesis" : "Finalizar"}
            {t === "anamnesis" && pending > 0 && (
              <span className="count" aria-label={`${pending} por revisar`}>
                {pending}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="panes" data-tab={tab}>
        <section className="pane pane-entrevista" aria-label="Transcripción">
          <Speakers snap={snap} onRole={(sp, r) => run(api.setRole(id, sp, r))} />
          <Transcript snap={snap} interim={interim} highlight={highlight} />
        </section>
        <section className="pane pane-anamnesis" aria-label="Borrador de anamnesis">
          <Draft
            snap={snap}
            onEvidence={jumpTo}
            onConfirm={(f, v) => run(api.confirm(id, f, v))}
            onNotReported={(f) => run(api.notReported(id, f))}
          />
        </section>
        <section className="pane pane-finalizar" aria-label="Revisión y exportación">
          <Review
            snap={snap}
            session={session}
            pending={pending}
            onGoTo={() => setTab("anamnesis")}
            onFinalize={(a) => run(api.finalize(id, a))}
            onDelete={() => {
              if (window.confirm("¿Eliminar esta entrevista del servidor? No se puede deshacer."))
                api.remove(id).then(onExit, (e: ApiError) => setError(e.message));
            }}
          />
        </section>
      </div>

      <ControlBar
        status={snap.status}
        onStart={start}
        onPause={() => run(api.command(id, "pausar"))}
        onResume={() => run(api.command(id, "reanudar"))}
        onStop={() => run(api.command(id, "detener"))}
      />

      {consentOpen && (
        <ConsentSheet
          onCancel={() => setConsentOpen(false)}
          onAccept={(by) =>
            api.consent(id, by).then(
              () => {
                setConsentOpen(false);
                run(api.command(id, "iniciar"));
              },
              (e: ApiError) => setError(e.message),
            )
          }
        />
      )}
    </div>
  );
}

function ListeningIndicator({ status }: { status: InterviewSnapshot["status"] }) {
  return (
    <span className={`listen listen-${status}`}>
      <span className="dot" aria-hidden="true" />
      {status === "escuchando" ? "Escuchando" : STATUS_TEXT[status]}
    </span>
  );
}

function ConnectionIndicator({ conn }: { conn: Connection }) {
  const text = {
    conectando: "Conectando…",
    conectado: "Conectado",
    reconectando: "Reconectando…",
    sin_conexion: "Sin conexión",
  }[conn];
  return <span className={`conn conn-${conn}`}>{text}</span>;
}

function PauseBanner({ reason }: { reason: string }) {
  const text =
    reason === "segundo_plano"
      ? "La escucha se pausó porque la app dejó de estar en pantalla (por ejemplo, una llamada o el bloqueo del teléfono). Toca Reanudar para continuar."
      : reason === "conexion"
        ? "La escucha se pausó porque se perdió la conexión. Toca Reanudar cuando vuelva."
        : "La escucha está pausada.";
  return (
    <p className="banner" role="status">
      {text}
    </p>
  );
}

function ConsentSheet({
  onAccept,
  onCancel,
}: {
  onAccept: (by: "paciente" | "representante") => void;
  onCancel: () => void;
}) {
  const [ok, setOk] = useState(false);
  const [by, setBy] = useState<"paciente" | "representante">("paciente");
  return (
    <div className="sheet-backdrop" role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="consent-title">
        <h2 id="consent-title">Consentimiento antes de escuchar</h2>
        <p>Antes de activar la escucha, informa a la persona:</p>
        <ul className="plain">
          <li>La conversación se transcribirá para preparar un borrador de anamnesis.</li>
          <li>El audio no se guarda.</li>
          <li>Tú revisarás y confirmarás todo antes de finalizar.</li>
          <li>Puede pedir que se pause o detenga en cualquier momento.</li>
        </ul>
        <fieldset className="radio-row">
          <legend>Quién otorga el consentimiento</legend>
          <label>
            <input type="radio" name="by" checked={by === "paciente"} onChange={() => setBy("paciente")} />
            Paciente
          </label>
          <label>
            <input
              type="radio"
              name="by"
              checked={by === "representante"}
              onChange={() => setBy("representante")}
            />
            Representante
          </label>
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          Informé lo anterior y la persona aceptó.
        </label>
        <div className="sheet-actions">
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!ok} onClick={() => onAccept(by)}>
            Registrar e iniciar
          </button>
        </div>
      </div>
    </div>
  );
}

function ControlBar(p: {
  status: InterviewSnapshot["status"];
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  if (p.status === "detenida" || p.status === "finalizada") return null;
  return (
    <div className="controlbar" role="toolbar" aria-label="Controles de escucha">
      {p.status === "preparada" && (
        <button className="btn primary big" onClick={p.onStart}>
          Iniciar escucha
        </button>
      )}
      {p.status === "escuchando" && (
        <button className="btn big" onClick={p.onPause}>
          Pausar
        </button>
      )}
      {p.status === "pausada" && (
        <button className="btn primary big" onClick={p.onResume}>
          Reanudar
        </button>
      )}
      {(p.status === "escuchando" || p.status === "pausada") && (
        <button className="btn danger big" onClick={p.onStop}>
          Detener
        </button>
      )}
    </div>
  );
}

function speakerName(snap: InterviewSnapshot, speaker: number) {
  const role = snap.speakerRoles[speaker] ?? "sin_asignar";
  return role === "sin_asignar" ? `Hablante ${speaker}` : `${ROLE_LABEL[role]} (hablante ${speaker})`;
}

function Speakers({ snap, onRole }: { snap: InterviewSnapshot; onRole: (sp: number, r: SpeakerRole) => void }) {
  const speakers = Object.keys(snap.speakerRoles).map(Number);
  if (!speakers.length) return null;
  const unassigned = speakers.some((s) => snap.speakerRoles[s] === "sin_asignar");
  return (
    <div className="speakers">
      <h2 className="small-head">Quién habla</h2>
      <p className="muted small">
        La app distingue voces, pero no sabe quién es el paciente. Indícalo tú.
        {unassigned && " Mientras falte, las propuestas quedan para revisión."}
      </p>
      <div className="speaker-grid">
        {speakers.map((s) => (
          <div key={s} className="speaker">
            <label htmlFor={`sp-${s}`}>Hablante {s}</label>
            <select
              id={`sp-${s}`}
              value={snap.speakerRoles[s]}
              disabled={snap.status === "finalizada"}
              onChange={(e) => onRole(s, e.target.value as SpeakerRole)}
            >
              {(["sin_asignar", "profesional", "paciente", "acompanante"] as SpeakerRole[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmt(sec: number) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

function Transcript({
  snap,
  interim,
  highlight,
}: {
  snap: InterviewSnapshot;
  interim: { speaker: number; text: string } | null;
  highlight: string | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (highlight) {
      document.getElementById(`seg-${highlight}`)?.scrollIntoView({ block: "center" });
    }
  }, [highlight]);
  useEffect(() => {
    if (!highlight && snap.status === "escuchando") endRef.current?.scrollIntoView({ block: "end" });
  }, [snap.segments.length, interim?.text, highlight, snap.status]);

  if (!snap.segments.length && !interim)
    return (
      <p className="empty">
        {snap.status === "preparada"
          ? "Inicia la escucha para ver aquí la transcripción. Primero se pedirá el consentimiento."
          : "Aún no hay texto transcrito."}
      </p>
    );
  return (
    <div className="transcript">
      <ol ref={listRef} className="segments">
        {snap.segments.map((s) => (
          <li
            key={s.id}
            id={`seg-${s.id}`}
            className={`segment ${highlight === s.id ? "flash" : ""} role-${snap.speakerRoles[s.speaker]}`}
          >
            <span className="seg-meta">
              {speakerName(snap, s.speaker)} <time>{fmt(s.start)}</time>
            </span>
            <span className="seg-text">{s.text}</span>
          </li>
        ))}
      </ol>
      {interim && (
        <p className="interim" aria-live="off">
          <span className="seg-meta">{speakerName(snap, interim.speaker)}, provisional</span>
          <span className="seg-text">{interim.text}</span>
        </p>
      )}
      <div ref={endRef} />
    </div>
  );
}

function StatusChip({ status }: { status: FieldState["status"] }) {
  const glyph = { no_referido: "○", propuesto: "◐", requiere_revision: "▲", confirmado: "✓" }[status];
  return (
    <span className={`chip chip-${status}`}>
      <span aria-hidden="true">{glyph}</span> {STATUS_LABEL[status]}
    </span>
  );
}

function Draft({
  snap,
  onEvidence,
  onConfirm,
  onNotReported,
}: {
  snap: InterviewSnapshot;
  onEvidence: (segId: string) => void;
  onConfirm: (fieldId: string, value: string | null) => void;
  onNotReported: (fieldId: string) => void;
}) {
  return (
    <div className="draft">
      <p className="muted small">
        Cada propuesta muestra el fragmento que la respalda. Toca un fragmento para verlo en la
        transcripción. Lo que no se mencionó queda como No referido.
      </p>
      {snap.template.sections.map((sec) => (
        <section key={sec.id} className="draft-section">
          <h2>{sec.title}</h2>
          {sec.fields.map((f) => (
            <FieldRow
              key={f.id}
              field={f}
              state={snap.fields[f.id]}
              locked={snap.status === "finalizada"}
              onEvidence={onEvidence}
              onConfirm={(v) => onConfirm(f.id, v)}
              onNotReported={() => onNotReported(f.id)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function FieldRow({
  field,
  state,
  locked,
  onEvidence,
  onConfirm,
  onNotReported,
}: {
  field: TemplateField;
  state: FieldState;
  locked: boolean;
  onEvidence: (segId: string) => void;
  onConfirm: (value: string | null) => void;
  onNotReported: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const shown = state.professionalValue ?? state.proposedValue ?? "No referido";
  const [text, setText] = useState(shown);
  const newItems = state.items.filter((i) => state.newItemIds.includes(i.id));
  const oldItems = state.items.filter((i) => !state.newItemIds.includes(i.id));

  return (
    <article className={`field st-${state.status}`} id={`field-${field.id}`}>
      <header className="field-head">
        <h3>{field.label}</h3>
        <StatusChip status={state.status} />
      </header>
      {field.hint && <p className="muted small">{field.hint}</p>}

      {editing ? (
        <div className="edit">
          <label className="sr-only" htmlFor={`t-${field.id}`}>
            Texto para {field.label}
          </label>
          <textarea id={`t-${field.id}`} value={text} rows={4} onChange={(e) => setText(e.target.value)} />
          <div className="actions">
            <button className="btn small" onClick={() => setEditing(false)}>
              Cancelar
            </button>
            <button
              className="btn small primary"
              onClick={() => {
                onConfirm(text);
                setEditing(false);
              }}
            >
              Guardar y confirmar
            </button>
          </div>
        </div>
      ) : (
        <p className={`value ${shown === "No referido" ? "muted" : ""}`}>
          {shown}
          {state.editedByProfessional && <span className="tag">Editado por ti</span>}
        </p>
      )}

      {state.reasons.length > 0 && (
        <ul className="reasons">
          {state.reasons.map((r) => (
            <li key={r}>{REASON_LABEL[r]}</li>
          ))}
        </ul>
      )}

      {oldItems.length > 0 && <Items items={oldItems} onEvidence={onEvidence} />}

      {newItems.length > 0 && (
        <div className="new-info">
          <p className="small">
            Información nueva después de tu confirmación. Tu texto no se cambió.
          </p>
          <Items items={newItems} onEvidence={onEvidence} />
          {!locked && (
            <div className="actions">
              <button className="btn small" onClick={() => onConfirm(state.professionalValue)}>
                Mantener mi texto
              </button>
              <button
                className="btn small primary"
                onClick={() =>
                  onConfirm([state.professionalValue, ...newItems.map((i) => i.value)].filter(Boolean).join("; "))
                }
              >
                Agregar al texto
              </button>
            </div>
          )}
        </div>
      )}

      {!locked && !editing && newItems.length === 0 && !field.manualOnly && (
        <div className="actions">
          {state.status !== "confirmado" && state.proposedValue && (
            <button className="btn small primary" onClick={() => onConfirm(null)}>
              Confirmar
            </button>
          )}
          <button
            className="btn small"
            onClick={() => {
              setText(shown === "No referido" ? "" : shown);
              setEditing(true);
            }}
          >
            Editar
          </button>
          {state.status !== "no_referido" && shown !== "No referido" && (
            <button className="btn small quiet" onClick={onNotReported}>
              Marcar No referido
            </button>
          )}
        </div>
      )}
      {!locked && !editing && field.manualOnly && (
        <div className="actions">
          <button
            className="btn small"
            onClick={() => {
              setText(shown === "No referido" ? "" : shown);
              setEditing(true);
            }}
          >
            Escribir
          </button>
        </div>
      )}
    </article>
  );
}

function Items({ items, onEvidence }: { items: ProposalItem[]; onEvidence: (s: string) => void }) {
  return (
    <ul className="items">
      {items.map((it) => (
        <li key={it.id} className={`item cls-${it.classification}`}>
          <span className="cls">{CLASSIFICATION_LABEL[it.classification]}</span>
          {it.corrected && <span className="cls corr">Corregido por quien habla</span>}
          {it.evidence.map((e) => (
            <span key={e.segmentId} className="evidence-wrap">
              {e.context && (
                <button className="evidence context" onClick={() => onEvidence(e.context!.segmentId)}>
                  {e.context.quote}
                </button>
              )}
              <button className="evidence" onClick={() => onEvidence(e.segmentId)}>
                <q>{e.quote}</q> <time>{fmt(e.start)}</time>
              </button>
            </span>
          ))}
          {it.corrected && (
            <span className="discarded">
              Descartado: <q>{it.corrected.discardedQuote}</q>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Review({
  snap,
  session,
  pending,
  onGoTo,
  onFinalize,
  onDelete,
}: {
  snap: InterviewSnapshot;
  session: SessionInfo;
  pending: number;
  onGoTo: () => void;
  onFinalize: (attested: boolean) => void;
  onDelete: () => void;
}) {
  const [attested, setAttested] = useState(false);
  const [evidence, setEvidence] = useState(false);
  const counts = Object.values(snap.fields).reduce<Record<string, number>>((acc, f) => {
    acc[f.status] = (acc[f.status] ?? 0) + 1;
    return acc;
  }, {});
  const exp = (format: string) =>
    `/api/interviews/${snap.id}/export?format=${format}${evidence ? "&respaldo=1" : ""}`;

  return (
    <div className="review">
      <dl className="tally">
        {(["confirmado", "propuesto", "requiere_revision", "no_referido"] as const).map((s) => (
          <div key={s}>
            <dt>
              <StatusChip status={s} />
            </dt>
            <dd>{counts[s] ?? 0}</dd>
          </div>
        ))}
      </dl>

      {snap.status === "finalizada" ? (
        <>
          <p className="ok">
            Finalizada y confirmada por {session.professional.name}. Ya no se puede editar.
          </p>
          <h2>Exportar</h2>
          <label className="check">
            <input type="checkbox" checked={evidence} onChange={(e) => setEvidence(e.target.checked)} />
            Incluir fragmentos de respaldo
          </label>
          {(snap.template.source?.kind === "docx" || snap.template.source?.kind === "xlsx") && (
            <p className="muted small">
              El formato de tu plantilla llena una copia del archivo original en los marcadores, líneas o
              celdas que confirmaste. Revisa el resultado: el diseño puede variar.
            </p>
          )}
          <div className="export-grid">
            <a className="btn" href={exp("txt")} download>
              Texto (.txt)
            </a>
            <a className="btn" href={exp("docx")} download>
              Word (.docx)
            </a>
            <a className="btn" href={exp("pdf")} download>
              PDF
            </a>
            {snap.template.source?.kind === "docx" && (
              <a className="btn" href={`/api/interviews/${snap.id}/export?format=original`} download>
                Word (formato de tu plantilla)
              </a>
            )}
            {snap.template.source?.kind === "xlsx" && (
              <a className="btn" href={`/api/interviews/${snap.id}/export?format=original`} download>
                Excel (formato de tu plantilla)
              </a>
            )}
          </div>
        </>
      ) : (
        <>
          {snap.status !== "detenida" && (
            <p className="banner">Detén la escucha para poder finalizar.</p>
          )}
          {pending > 0 && (
            <p className="banner warn">
              Quedan {pending} campos que requieren revisión.{" "}
              <button className="link" onClick={onGoTo}>
                Ir a revisarlos
              </button>
            </p>
          )}
          <label className="check">
            <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
            Revisé el borrador completo. Lo propuesto que no modifiqué queda confirmado tal como está.
          </label>
          <button
            className="btn primary wide"
            disabled={!attested || pending > 0 || snap.status !== "detenida"}
            onClick={() => onFinalize(attested)}
          >
            Finalizar anamnesis
          </button>
        </>
      )}

      <h2>Eliminar</h2>
      <p className="muted small">
        Se elimina automáticamente el {new Date(snap.expiresAt).toLocaleString("es-CL")} si no hay
        actividad.
      </p>
      <button className="btn danger" onClick={onDelete}>
        Eliminar entrevista ahora
      </button>
    </div>
  );
}
