/**
 * Modo sin conexión manual: preparar el dispositivo, desbloquear, escribir
 * borradores y sincronizarlos con la cuenta. Sin micrófono ni IA.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CONFLICT_TEXT, LOCAL_SYNC_LABEL, OFFLINE_CUTOFF_NOTICE, OFFLINE_PASSPHRASE_MIN } from "../../shared/offline";
import { allFields } from "../../shared/template-generic";
import type { SessionInfo } from "../../shared/types";
import { offlineApi } from "../api";
import { CancelledError } from "../session";
import { WrongPassphraseError } from "./crypto";
import { backend, lockVault, offlineChannel, setVault, useVault } from "./current";
import {
  draftStatus,
  type LocalDraft,
  liveSpaces,
  OfflineVault,
  type SpaceMeta,
  spaceFor,
  StaleDraftError,
} from "./vault";

const fmtTime = (iso: string | number) =>
  new Date(iso).toLocaleString("es-CL", { timeZone: "America/Santiago", dateStyle: "short", timeStyle: "short" });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Ocurrió un error.");

export function CutoffNotice() {
  return (
    <p className="info-box" role="note">
      {OFFLINE_CUTOFF_NOTICE}
    </p>
  );
}

// ---- Panel en «Mis anamnesis» (con sesión) ----

export function OfflinePanel({ session, onOpen }: { session: SessionInfo; onOpen: () => void }) {
  const vault = useVault();
  const [space, setSpace] = useState<SpaceMeta | null | undefined>(undefined);
  const mine = vault && vault.profile.professional.id === session.professional.id ? vault : null;

  useEffect(() => {
    spaceFor(backend, session.professional.id).then(
      (s) => setSpace(s ?? null),
      () => setSpace(null),
    );
  }, [session.professional.id, vault]);

  return (
    <section className="panel" aria-labelledby="sin-conexion">
      <h2 id="sin-conexion">Trabajo sin conexión</h2>
      <p className="muted small">
        Escribe anamnesis a mano cuando no haya internet (sin micrófono ni propuestas automáticas). Se guardan cifradas en
        este dispositivo y se sincronizan con tu cuenta al volver la conexión.
      </p>
      <CutoffNotice />
      {space === undefined ? (
        <p className="muted">Revisando este dispositivo…</p>
      ) : mine ? (
        <button className="btn primary" onClick={onOpen}>
          Abrir borradores de este dispositivo
        </button>
      ) : space ? (
        <UnlockForm
          spaces={[space]}
          onUnlocked={(v) => {
            setVault(v);
            onOpen();
          }}
        />
      ) : (
        <PrepareForm
          session={session}
          onReady={(v) => {
            setVault(v);
            onOpen();
          }}
        />
      )}
    </section>
  );
}

function PrepareForm({ session, onReady }: { session: SessionInfo; onReady: (v: OfflineVault) => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (a.length < OFFLINE_PASSPHRASE_MIN) return setError(`La frase debe tener al menos ${OFFLINE_PASSPHRASE_MIN} caracteres.`);
    if (a !== b) return setError("Las frases no coinciden.");
    setBusy(true);
    try {
      const pkg = await offlineApi.package();
      onReady(await OfflineVault.prepare(backend, pkg, a, session.idleMinutes));
    } catch (e) {
      if (!(e instanceof CancelledError)) setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <p className="small">
        Para preparar este dispositivo, elige una <strong>frase de desbloqueo</strong> solo para hoy. No uses la contraseña de
        tu cuenta. Si la olvidas, los borradores no se pueden recuperar.
      </p>
      <label className="field-label">
        Frase de desbloqueo (mínimo {OFFLINE_PASSPHRASE_MIN} caracteres)
        <input type="password" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} />
      </label>
      <label className="field-label">
        Repite la frase
        <input type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} />
      </label>
      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? "Preparando…" : "Preparar este dispositivo"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function UnlockForm({ spaces, onUnlocked }: { spaces: SpaceMeta[]; onUnlocked: (v: OfflineVault) => void }) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fails = useRef(0);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Espera creciente tras intentos fallidos (además del costo de PBKDF2).
      if (fails.current) await new Promise((r) => setTimeout(r, Math.min(fails.current, 10) * 1000));
      for (const s of spaces) {
        try {
          const v = await OfflineVault.unlock(backend, s, pass);
          fails.current = 0;
          setPass("");
          onUnlocked(v);
          return;
        } catch (err) {
          if (!(err instanceof WrongPassphraseError)) throw err;
        }
      }
      fails.current++;
      setError("La frase de desbloqueo no es correcta.");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <label className="field-label">
        Frase de desbloqueo de este dispositivo
        <input type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      <button className="btn primary" type="submit" disabled={busy || !pass}>
        {busy ? "Abriendo…" : "Desbloquear borradores"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// ---- Sin sesión (sin conexión o después de cerrar sesión) ----

export function OfflineGate({ reason, onBack }: { reason: "sin_conexion" | "manual"; onBack?: () => void }) {
  const vault = useVault();
  const [spaces, setSpaces] = useState<SpaceMeta[] | null>(null);
  useEffect(() => {
    liveSpaces(backend).then(setSpaces, () => setSpaces([]));
  }, [vault]);
  if (vault) return <OfflineWorkspace vault={vault} session={null} onExit={onBack} />;
  return (
    <main className="welcome">
      <h1>Borradores sin conexión</h1>
      {reason === "sin_conexion" && (
        <p className="banner warn" role="status">
          Sin conexión con el servidor. Puedes abrir los borradores cifrados de este dispositivo; se sincronizarán cuando
          vuelvas a iniciar sesión con conexión.
        </p>
      )}
      <CutoffNotice />
      {spaces === null ? (
        <p className="muted">Revisando este dispositivo…</p>
      ) : spaces.length === 0 ? (
        <p className="empty">No hay borradores guardados en este dispositivo.</p>
      ) : (
        <UnlockForm spaces={spaces} onUnlocked={setVault} />
      )}
      {onBack && (
        <button className="link" onClick={onBack}>
          Volver
        </button>
      )}
    </main>
  );
}

// ---- Espacio de trabajo ----

export function OfflineWorkspace({
  vault,
  session,
  onExit,
  onOpenInterview,
}: {
  vault: OfflineVault;
  session: SessionInfo | null;
  onExit?: () => void;
  onOpenInterview?: (id: string) => void;
}) {
  const [drafts, setDrafts] = useState<LocalDraft[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState(vault.profile.templates[0]?.id ?? "generica");
  const [online, setOnline] = useState(navigator.onLine);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const syncingRef = useRef(false);
  const canSync = Boolean(session && session.professional.id === vault.profile.professional.id);

  const reload = useCallback(async () => {
    try {
      setDrafts(await vault.drafts());
    } catch (e) {
      setError(errMsg(e));
    }
  }, [vault]);

  const sync = useCallback(async () => {
    if (!canSync || syncingRef.current || vault.locked) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const r = await vault.syncAll(session!.professional.id, offlineApi.send);
      setSyncMsg(
        r.offline
          ? "Sin conexión: los borradores quedan pendientes de sincronizar."
          : r.failed
            ? `${r.failed} borrador(es) con error de sincronización: revísalos abajo.`
            : r.synced
              ? `${r.synced} borrador(es) sincronizados con tu cuenta. Se eliminó su contenido de este dispositivo.`
              : null,
      );
      offlineChannel?.postMessage({ type: "cambio" });
    } catch (e) {
      if (!(e instanceof CancelledError)) setSyncMsg(errMsg(e));
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      void reload();
    }
  }, [canSync, session, vault, reload]);

  useEffect(() => {
    void reload().then(() => {
      if (navigator.onLine) void sync();
    });
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "cambio") void reload();
      if (e.data?.type === "eliminado") lockVault();
    };
    offlineChannel?.addEventListener("message", onMsg);
    const up = () => {
      setOnline(true);
      void sync();
    };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      offlineChannel?.removeEventListener("message", onMsg);
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, [reload, sync]);

  // Corte diario: aviso 5 minutos antes y eliminación al llegar, aunque no se haya sincronizado.
  useEffect(() => {
    const cutoffIn = vault.space.cutoffAt - vault.now();
    const pending = () => (drafts ?? []).filter((d) => draftStatus(d) !== "sincronizado").length;
    const warnT = setTimeout(
      () => {
        setWarning(`A las 23:59 (hora de Chile) se eliminarán los borradores de este dispositivo. ${OFFLINE_CUTOFF_NOTICE}`);
        void sync();
      },
      Math.max(0, Math.min(cutoffIn - 5 * 60_000, 2 ** 31 - 1)),
    );
    const endT = setTimeout(
      () => {
        const n = pending();
        void vault.destroy().finally(() => {
          offlineChannel?.postMessage({ type: "eliminado" });
          lockVault();
          alertAfterCutoff(n);
        });
      },
      Math.max(0, Math.min(cutoffIn, 2 ** 31 - 1)),
    );
    return () => {
      clearTimeout(warnT);
      clearTimeout(endT);
    };
  }, [vault, drafts, sync]);

  // Bloqueo local por inactividad (no habla con el servidor ni prolonga la sesión).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(t);
      t = setTimeout(lockVault, vault.profile.idleMinutes * 60_000);
    };
    const evs = ["pointerdown", "keydown", "input"] as const;
    for (const e of evs) window.addEventListener(e, arm, { passive: true });
    arm();
    return () => {
      clearTimeout(t);
      for (const e of evs) window.removeEventListener(e, arm);
    };
  }, [vault]);

  const create = async () => {
    setError(null);
    try {
      const d = await vault.newDraft(templateId);
      offlineChannel?.postMessage({ type: "cambio" });
      await reload();
      setEditing(d.id);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const current = editing ? drafts?.find((d) => d.id === editing) : undefined;
  if (current) {
    return (
      <DraftEditor
        vault={vault}
        draft={current}
        onClose={() => {
          setEditing(null);
          void reload().then(() => void sync());
        }}
        onSaved={() => offlineChannel?.postMessage({ type: "cambio" })}
      />
    );
  }

  return (
    <main className="home offline">
      <header className="home-head">
        <div>
          <h1>Borradores en este dispositivo</h1>
          <p className="muted">{vault.profile.professional.name}</p>
        </div>
        <div className="head-actions">
          <button className="btn small" onClick={lockVault}>
            Bloquear
          </button>
        </div>
      </header>
      {warning && (
        <p className="cutoff-warning" role="alert">
          {warning}
        </p>
      )}
      <p className={`banner ${online && canSync ? "" : "warn"}`} role="status">
        {!online
          ? "Sin conexión: lo que escribas se guarda solo en este dispositivo, cifrado."
          : canSync
            ? "Con conexión: los borradores se sincronizan con tu cuenta."
            : "Para sincronizar, inicia sesión con tu cuenta (con conexión)."}
      </p>
      <CutoffNotice />
      <p className="muted small">
        Vencen a las {fmtTime(vault.space.cutoffAt)} (hora de Chile). Modo manual: sin micrófono ni propuestas automáticas.
      </p>

      <label className="field-label" htmlFor="plantilla-offline">
        Plantilla
      </label>
      <select id="plantilla-offline" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
        {vault.profile.templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} (v{t.version})
          </option>
        ))}
      </select>
      <button className="btn primary wide" onClick={create}>
        Nueva anamnesis manual
      </button>
      {canSync && (
        <button className="btn wide-secondary" onClick={() => void sync()} disabled={syncing}>
          {syncing ? "Sincronizando…" : "Sincronizar ahora"}
        </button>
      )}
      {syncMsg && (
        <p className="banner" role="status">
          {syncMsg}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section aria-label="Borradores de este dispositivo">
        {drafts === null ? (
          <p className="muted">Cargando…</p>
        ) : drafts.length === 0 ? (
          <p className="empty">No hay borradores en este dispositivo.</p>
        ) : (
          <ul className="interview-list">
            {drafts.map((d) => (
              <DraftRow
                key={d.id}
                d={d}
                onEdit={() => setEditing(d.id)}
                onOpenInterview={canSync ? onOpenInterview : undefined}
                onCopy={async () => {
                  await vault.asNewCopy(d.id);
                  await reload();
                  void sync();
                }}
                onDelete={async () => {
                  if (!window.confirm("¿Eliminar este borrador de este dispositivo? No se puede deshacer.")) return;
                  await vault.deleteDraft(d.id);
                  offlineChannel?.postMessage({ type: "cambio" });
                  await reload();
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <div className="actions">
        {onExit && (
          <button className="link" onClick={onExit}>
            Volver
          </button>
        )}
        <button
          className="link danger"
          onClick={async () => {
            const n = (drafts ?? []).filter((d) => draftStatus(d) !== "sincronizado").length;
            const msg = n
              ? `Hay ${n} borrador(es) sin sincronizar. Se eliminarán de este dispositivo y no se podrán recuperar. ¿Continuar?`
              : "¿Eliminar todos los borradores de este dispositivo?";
            if (!window.confirm(msg)) return;
            await vault.destroy();
            offlineChannel?.postMessage({ type: "eliminado" });
            lockVault();
          }}
        >
          Eliminar todos los borradores de este dispositivo
        </button>
      </div>
    </main>
  );
}

function alertAfterCutoff(pending: number) {
  const el = document.createElement("p");
  el.className = "cutoff-warning";
  el.setAttribute("role", "alert");
  el.textContent = pending
    ? `Corte diario: se eliminaron los borradores de este dispositivo, incluidos ${pending} sin sincronizar.`
    : "Corte diario: se eliminaron los borradores de este dispositivo.";
  document.body.prepend(el);
}

function DraftRow({
  d,
  onEdit,
  onOpenInterview,
  onCopy,
  onDelete,
}: {
  d: LocalDraft;
  onEdit: () => void;
  onOpenInterview?: (id: string) => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const st = draftStatus(d);
  return (
    <li className="offline-row">
      <div className="row-btn static">
        <span>
          {d.title}
          <span className="muted small block">
            {d.templateName} · modificado {fmtTime(d.updatedAt)}
          </span>
        </span>
        <span className={`pill sync-${st}`}>{LOCAL_SYNC_LABEL[st]}</span>
      </div>
      {d.conflict ? (
        <div className="conflict" role="alert">
          <p className="small">{CONFLICT_TEXT[d.conflict.reason] ?? d.conflict.message} La copia de este dispositivo se conserva.</p>
          <div className="actions">
            <button className="btn small" onClick={onEdit}>
              Ver copia del dispositivo
            </button>
            {onOpenInterview && d.conflict.reason !== "eliminada_en_servidor" && (
              <button className="btn small" onClick={() => onOpenInterview(d.conflict!.interviewId)}>
                Ver la de tu cuenta
              </button>
            )}
            <button className="btn small" onClick={onCopy}>
              Guardar como anamnesis nueva
            </button>
            <button className="btn small danger" onClick={onDelete}>
              Descartar la copia del dispositivo
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          {st === "sincronizado" ? (
            onOpenInterview &&
            d.interviewId && (
              <button className="btn small" onClick={() => onOpenInterview(d.interviewId!)}>
                Abrir en Mis anamnesis
              </button>
            )
          ) : (
            <button className="btn small" onClick={onEdit}>
              Editar
            </button>
          )}
          {d.error && <span className="error small">{d.error}</span>}
          <button className="btn small danger" onClick={onDelete}>
            Eliminar del dispositivo
          </button>
        </div>
      )}
    </li>
  );
}

function DraftEditor({
  vault,
  draft,
  onClose,
  onSaved,
}: {
  vault: OfflineVault;
  draft: LocalDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const template = vault.template(draft);
  const [values, setValues] = useState<Record<string, string>>(draft.fields);
  const [rev, setRev] = useState(draft.revision);
  const [state, setState] = useState<{ kind: "inactivo" | "guardando" | "guardado" | "error"; at?: string; msg?: string }>({
    kind: "inactivo",
  });
  const [conflict, setConflict] = useState<LocalDraft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ values, rev });
  latest.current = { values, rev };
  const readOnly = Boolean(draft.conflict) || draft.stub;

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { values: v, rev: r } = latest.current;
    setState({ kind: "guardando" });
    try {
      const saved = await vault.saveFields(draft.id, v, r);
      setRev(saved.revision);
      latest.current.rev = saved.revision;
      setState({ kind: "guardado", at: saved.updatedAt });
      onSaved();
      return true;
    } catch (e) {
      if (e instanceof StaleDraftError) setConflict(e.current);
      setState({ kind: "error", msg: errMsg(e) });
      return false;
    }
  }, [vault, draft.id, onSaved]);

  useEffect(
    () => () => {
      if (timer.current) void flush();
    },
    [flush],
  );

  if (!template)
    return (
      <main className="home">
        <p className="error">La plantilla de este borrador no está disponible en este dispositivo.</p>
        <button className="btn" onClick={onClose}>
          Volver
        </button>
      </main>
    );

  const change = (id: string, text: string) => {
    setValues((v) => ({ ...v, [id]: text }));
    latest.current = { ...latest.current, values: { ...latest.current.values, [id]: text } };
    if (timer.current) clearTimeout(timer.current);
    if (!conflict) timer.current = setTimeout(() => void flush(), 500);
  };

  return (
    <main className="interview offline-editor">
      <header className="home-head">
        <div>
          <h1>{draft.title}</h1>
          <p className="muted small">
            {draft.templateName} · Modo manual sin conexión: lo escrito queda marcado como edición del profesional; lo vacío
            queda «No referido».
          </p>
        </div>
        <div className="head-actions">
          <span className={`save save-${state.kind}`} role="status" title={state.msg}>
            {state.kind === "guardando"
              ? "Guardando…"
              : state.kind === "guardado"
                ? `Guardado en este dispositivo ${new Date(state.at!).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}`
                : state.kind === "error"
                  ? "Error al guardar en este dispositivo"
                  : ""}
          </span>
        </div>
      </header>
      {state.kind === "error" && (
        <p className="error" role="alert">
          {state.msg}
        </p>
      )}
      {conflict && (
        <div className="head-actions">
          <button
            className="btn"
            disabled={state.kind === "guardando"}
            onClick={async () => {
              setState({ kind: "guardando" });
              try {
                await vault.asNewCopy(draft.id, latest.current.values);
                onSaved();
                onClose();
              } catch (e) {
                setState({ kind: "error", msg: errMsg(e) });
              }
            }}
          >
            Guardar mi versión como copia
          </button>
          <button
            className="btn"
            disabled={state.kind === "guardando"}
            onClick={() => {
              setValues(conflict.fields);
              setRev(conflict.revision);
              setConflict(null);
              setState({ kind: "inactivo" });
            }}
          >
            Cargar la versión guardada
          </button>
        </div>
      )}
      {readOnly && (
        <p className="banner warn" role="status">
          Copia de solo lectura: resuelve el conflicto desde la lista de borradores.
        </p>
      )}
      <CutoffNotice />
      {template.sections.map((s) => (
        <section key={s.id} className="panel" aria-labelledby={`sec-${s.id}`}>
          <h2 id={`sec-${s.id}`}>{s.title}</h2>
          {s.fields.map((f) => (
            <label key={f.id} className="field-label">
              {f.label}
              {f.critical && <span className="muted small"> (verificar con el paciente)</span>}
              <textarea
                rows={2}
                maxLength={5000}
                placeholder="No referido"
                readOnly={readOnly}
                value={values[f.id] ?? ""}
                onChange={(e) => change(f.id, e.target.value)}
              />
            </label>
          ))}
        </section>
      ))}
      <p className="muted small">
        {allFields(template).filter((f) => !(values[f.id] ?? "").trim()).length} campos quedarán «No referido». La revisión y la
        finalización se hacen en Mis anamnesis, después de sincronizar.
      </p>
      <button
        className="btn primary wide"
        disabled={Boolean(conflict) || state.kind === "guardando"}
        onClick={async () => {
          if ((timer.current || state.kind === "error") && !(await flush())) return;
          onClose();
        }}
      >
        Guardar y volver
      </button>
    </main>
  );
}

