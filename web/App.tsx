import { useEffect, useState } from "react";
import type { ImportAnalysis, InterviewSummary, SessionInfo, TemplateSummary } from "../shared/types";
import { accounts, api, ApiError, type ListFilter } from "./api";
import { InterviewScreen } from "./Interview";
import { PrivacyScreen } from "./Privacy";
import {
  clearLocalData,
  endSession,
  installLifecycleChecks,
  setSession as setSessionClock,
  useSessionState,
} from "./session";
import { TemplateEditorScreen, TemplatesScreen } from "./Templates";

type View =
  | { name: "home" }
  | { name: "interview"; id: string }
  | { name: "privacy" }
  | { name: "templates" }
  | { name: "template"; id: string }
  | { name: "import"; analysis: ImportAnalysis };

const EXIT_MESSAGES: Record<string, string> = {
  manual: "Cerraste la sesión. Los datos temporales de este dispositivo se limpiaron.",
  sesion_vencida: "La sesión venció en el corte diario de las 23:59 (hora de Chile). Se limpiaron los datos temporales.",
  corte_diario: "La sesión venció en el corte diario de las 23:59 (hora de Chile). Se limpiaron los datos temporales.",
  vencimiento: "La sesión venció. Se limpiaron los datos temporales de este dispositivo.",
  vencimiento_sin_conexion: "La sesión venció sin conexión. Se limpiaron los datos temporales de este dispositivo.",
  bloqueo_inactividad: "La sesión se bloqueó por inactividad. Se limpiaron los datos temporales.",
  otra_pestana: "La sesión se cerró en otra pestaña. Se limpiaron los datos temporales.",
  sin_sesion: "Tu sesión ya no es válida. Inicia sesión de nuevo.",
};

export function App() {
  const [session, setSession] = useState<SessionInfo | null | undefined>(undefined);
  const [authMode, setAuthMode] = useState<"demo" | "cuentas">("demo");
  const [view, setView] = useState<View>({ name: "home" });
  const params = new URLSearchParams(location.search);
  const exitReason = params.get("salida");
  const resetToken = location.pathname === "/restablecer" ? params.get("token") : null;
  const resetError = location.pathname === "/restablecer" ? params.get("error") : null;

  useEffect(() => {
    // Antes de mostrar datos clínicos se comprueba la sesión con el servidor.
    api.health().then((h) => setAuthMode(h.auth), () => undefined);
    api.session().then(
      (s) => {
        setSessionClock(s);
        setSession(s);
      },
      () => {
        // Sin sesión válida: se limpia lo que haya quedado de usos o versiones anteriores.
        void clearLocalData();
        setSession(null);
      },
    );
  }, []);

  useEffect(() => {
    if (!session) return;
    installLifecycleChecks((s) => {
      if (s) setSession(s);
    });
  }, [session === null || session === undefined]);

  const logged = (s: SessionInfo) => {
    history.replaceState(null, "", "/");
    setSessionClock(s);
    setSession(s);
  };

  if (session === undefined) return <main className="center muted">Comprobando la sesión…</main>;
  if (view.name === "privacy") return <PrivacyScreen onBack={() => setView({ name: "home" })} />;
  if (!session) {
    if (resetToken || resetError) return <ResetPassword token={resetToken} error={resetError} />;
    return (
      <Welcome
        authMode={authMode}
        onLogin={logged}
        notice={
          params.get("verificado") === "1"
            ? "Correo verificado. Ya puedes iniciar sesión."
            : exitReason
              ? (EXIT_MESSAGES[exitReason] ?? EXIT_MESSAGES.sin_sesion)
              : null
        }
        onPrivacy={() => setView({ name: "privacy" })}
      />
    );
  }
  const shell = (content: React.ReactNode) => (
    <>
      <SessionBanner />
      {content}
    </>
  );
  if (view.name === "interview")
    return shell(<InterviewScreen id={view.id} session={session} onExit={() => setView({ name: "home" })} />);
  if (view.name === "templates")
    return shell(
      <TemplatesScreen
        onBack={() => setView({ name: "home" })}
        onOpen={(id) => setView({ name: "template", id })}
        onImported={(analysis) => setView({ name: "import", analysis })}
      />,
    );
  if (view.name === "template" || view.name === "import")
    return shell(
      <TemplateEditorScreen
        key={view.name === "template" ? view.id : view.analysis.importId}
        id={view.name === "template" ? view.id : undefined}
        analysis={view.name === "import" ? view.analysis : undefined}
        onBack={() => setView({ name: "templates" })}
        onSaved={(id) => setView({ name: "template", id })}
      />,
    );
  return shell(
    <Home
      session={session}
      onSession={(s) => (s ? logged(s) : setSession(null))}
      onOpen={(id) => setView({ name: "interview", id })}
      onPrivacy={() => setView({ name: "privacy" })}
      onTemplates={() => setView({ name: "templates" })}
    />,
  );
}

export function DemoNotice() {
  return (
    <p className="demo-notice" role="note">
      Demostración con datos ficticios. No se activa el micrófono ni se envían datos a otros servicios.
    </p>
  );
}

/** Aviso previo al corte diario e indicador de guardado. */
function SessionBanner() {
  const st = useSessionState();
  return st.warning ? (
    <p className="cutoff-warning" role="alert">
      {st.warning}
    </p>
  ) : null;
}

export function SaveIndicator() {
  const { save } = useSessionState();
  if (save.kind === "inactivo") return null;
  const text =
    save.kind === "guardando"
      ? "Guardando…"
      : save.kind === "guardado"
        ? `Guardado ${save.at.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}`
        : "Error al guardar";
  return (
    <span className={`save save-${save.kind}`} role="status" title={save.kind === "error" ? save.message : undefined}>
      {text}
    </span>
  );
}

function Welcome({
  authMode,
  onLogin,
  onPrivacy,
  notice,
}: {
  authMode: "demo" | "cuentas";
  onLogin: (s: SessionInfo) => void;
  onPrivacy: () => void;
  notice: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(notice);
  const [mode, setMode] = useState<"entrar" | "crear" | "recuperar">("entrar");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "entrar")
      void run(async () => {
        await accounts.signIn(email, password);
        onLogin(await api.session());
      });
    else if (mode === "crear")
      void run(async () => {
        await accounts.signUp(name, email, password);
        setInfo("Te enviamos un correo para verificar tu cuenta. Ábrelo y luego inicia sesión.");
        setMode("entrar");
        setPassword("");
      });
    else
      void run(async () => {
        await accounts.requestReset(email);
        setInfo("Si el correo tiene una cuenta, te llegará un enlace para elegir una contraseña nueva.");
        setMode("entrar");
      });
  };

  return (
    <main className="welcome">
      <header className="welcome-head">
        <h1>Anamnesis Automática</h1>
        <p className="lede">
          Escucha la entrevista, transcribe en español y propone cada campo con el fragmento que lo respalda.
          Tú revisas y confirmas.
        </p>
      </header>
      {info && (
        <p className="banner" role="status">
          {info}
        </p>
      )}
      {authMode === "demo" ? (
        <>
          <DemoNotice />
          <section className="panel" aria-labelledby="perfiles">
            <h2 id="perfiles">Entrar a la demostración</h2>
            <p className="muted">
              Dos profesionales ficticios para comprobar que cada uno ve solo sus entrevistas. No se usan contraseñas en
              este modo.
            </p>
            <div className="stack">
              <button className="btn primary" onClick={() => run(async () => onLogin(await api.demoLogin("demo-a")))}>
                Entrar como Profesional Demo A
              </button>
              <button className="btn" onClick={() => run(async () => onLogin(await api.demoLogin("demo-b")))}>
                Entrar como Profesional Demo B
              </button>
            </div>
          </section>
        </>
      ) : (
        <section className="panel" aria-labelledby="acceso">
          <h2 id="acceso">
            {mode === "entrar" ? "Iniciar sesión" : mode === "crear" ? "Crear cuenta" : "Recuperar contraseña"}
          </h2>
          <p className="muted small">Versión de pruebas: usa solo datos ficticios.</p>
          <form className="stack" onSubmit={submit}>
            {mode === "crear" && (
              <label className="field-label">
                Nombre
                <input type="text" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            )}
            <label className="field-label">
              Correo
              <input
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {mode !== "recuperar" && (
              <label className="field-label">
                Contraseña
                <input
                  type="password"
                  autoComplete={mode === "crear" ? "new-password" : "current-password"}
                  minLength={10}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            )}
            <button className="btn primary" disabled={busy} type="submit">
              {mode === "entrar" ? "Iniciar sesión" : mode === "crear" ? "Crear cuenta" : "Enviar enlace"}
            </button>
          </form>
          <div className="actions">
            {mode !== "entrar" && (
              <button className="link" onClick={() => setMode("entrar")}>
                Ya tengo cuenta
              </button>
            )}
            {mode !== "crear" && (
              <button className="link" onClick={() => setMode("crear")}>
                Crear cuenta
              </button>
            )}
            {mode !== "recuperar" && (
              <button className="link" onClick={() => setMode("recuperar")}>
                Olvidé mi contraseña
              </button>
            )}
          </div>
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="link" onClick={onPrivacy}>
        Qué datos se usan y dónde
      </button>
    </main>
  );
}

function ResetPassword({ token, error }: { token: string | null; error: string | null }) {
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<string | null>(error ? "El enlace no es válido o ya venció. Pide uno nuevo." : null);
  const [done, setDone] = useState(false);
  return (
    <main className="welcome">
      <h1>Elegir contraseña nueva</h1>
      {msg && (
        <p className={done ? "banner" : "error"} role="alert">
          {msg}
        </p>
      )}
      {token && !done && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            accounts.resetPassword(token, pw).then(
              () => {
                setDone(true);
                setMsg("Contraseña actualizada. Por seguridad se cerraron tus otras sesiones.");
              },
              (e: ApiError) => setMsg(e.message),
            );
          }}
        >
          <label className="field-label">
            Contraseña nueva (mínimo 10 caracteres)
            <input type="password" autoComplete="new-password" minLength={10} required value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
          <button className="btn primary" type="submit">
            Guardar contraseña
          </button>
        </form>
      )}
      <a className="link" href="/">
        Ir a iniciar sesión
      </a>
    </main>
  );
}

const STATE_LABEL: Record<string, string> = {
  preparada: "Borrador",
  escuchando: "Borrador (escuchando)",
  pausada: "Borrador (pausada)",
  detenida: "Borrador",
  finalizada: "Revisada",
};

function Home({
  session,
  onSession,
  onOpen,
  onPrivacy,
  onTemplates,
}: {
  session: SessionInfo;
  onSession: (s: SessionInfo | null) => void;
  onOpen: (id: string) => void;
  onPrivacy: () => void;
  onTemplates: () => void;
}) {
  const [list, setList] = useState<InterviewSummary[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templateId, setTemplateId] = useState("generica");
  const [filter, setFilter] = useState<ListFilter>({ estado: "" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.list(filter).then(setList, (e: ApiError) => e.status && setError(e.message));
  }, [filter]);
  useEffect(() => {
    api.templates().then(setTemplates, () => undefined);
  }, []);

  const create = () => api.create(templateId).then((s) => onOpen(s.id), (e: ApiError) => e.status !== undefined && setError(e.message));

  return (
    <main className="home">
      <header className="home-head">
        <div>
          <h1>Mis anamnesis</h1>
          <p className="muted">
            {session.professional.name}
            {session.professional.email ? `, ${session.professional.email}` : ""}
          </p>
        </div>
        <div className="head-actions">
          <SaveIndicator />
          <button className="btn small" onClick={() => void endSession("manual", true, true)}>
            Cerrar sesión
          </button>
        </div>
      </header>
      {session.demo && <DemoNotice />}
      <label className="field-label" htmlFor="plantilla">
        Plantilla para la nueva anamnesis
      </label>
      <select id="plantilla" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
        {(templates.length ? templates : [{ id: "generica", name: "Anamnesis general", version: 1 }]).map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} (v{t.version})
          </option>
        ))}
      </select>
      <button className="btn primary wide" onClick={create}>
        Nueva entrevista
      </button>
      <button className="btn wide-secondary" onClick={onTemplates}>
        Plantillas
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section aria-labelledby="buscar">
        <h2 id="buscar">Buscar</h2>
        <div className="filters">
          <label className="field-label">
            Estado
            <select value={filter.estado} onChange={(e) => setFilter({ ...filter, estado: e.target.value as ListFilter["estado"] })}>
              <option value="">Todas</option>
              <option value="borrador">Borrador</option>
              <option value="revisada">Revisada</option>
            </select>
          </label>
          <label className="field-label">
            Desde
            <input type="date" value={filter.desde ?? ""} onChange={(e) => setFilter({ ...filter, desde: e.target.value || undefined })} />
          </label>
          <label className="field-label">
            Hasta
            <input type="date" value={filter.hasta ?? ""} onChange={(e) => setFilter({ ...filter, hasta: e.target.value || undefined })} />
          </label>
        </div>
      </section>

      <section aria-label="Tus anamnesis">
        {list === null ? (
          <p className="muted">Cargando…</p>
        ) : list.length === 0 ? (
          <p className="empty">No hay anamnesis con estos filtros.</p>
        ) : (
          <ul className="interview-list">
            {list.map((i) => (
              <li key={i.id}>
                <button className="row-btn" onClick={() => onOpen(i.id)}>
                  <span>
                    {i.title}
                    <span className="muted small block">
                      Modificada {new Date(i.updatedAt).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" })}
                    </span>
                  </span>
                  <span className={`pill st-${i.status}`}>{STATE_LABEL[i.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="config">
        <h2 id="config">Configuración</h2>
        <p className="info-box">
          Las anamnesis guardadas permanecen en tu cuenta. A las 23:59, hora de Chile, vence la sesión y se limpian los datos
          temporales cuando la aplicación está activa, o al volver a abrirla. Los documentos descargados deben eliminarse
          manualmente.
        </p>
        <p className="muted small">
          Esta sesión vence a las{" "}
          {new Date(session.cutoffAt).toLocaleString("es-CL", { timeZone: "America/Santiago", dateStyle: "short", timeStyle: "short" })}{" "}
          (hora de Chile).
        </p>
        <label className="field-label" htmlFor="inactividad">
          Bloquear por inactividad después de
        </label>
        <select
          id="inactividad"
          value={session.idleMinutes}
          onChange={(e) => api.setSettings({ idleMinutes: Number(e.target.value) }).then(onSession, () => undefined)}
        >
          {session.idleOptions.map((m) => (
            <option key={m} value={m}>
              {m} minutos
            </option>
          ))}
        </select>
        <h3 className="sub-head">Historial en el servidor</h3>
        <p className="muted small">
          Es independiente de la limpieza de este dispositivo. Por defecto tus anamnesis guardadas, incluidas las
          finalizadas, no se eliminan automáticamente.
        </p>
        <label className="field-label" htmlFor="historial">
          Eliminación automática del historial
        </label>
        <select
          id="historial"
          value={session.historyRetentionDays === null ? "" : String(session.historyRetentionDays)}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) {
              api.setSettings({ historyRetentionDays: null }).then(onSession, () => undefined);
              return;
            }
            const days = Number(v);
            const ok = window.confirm(
              `Se eliminarán del servidor, de forma permanente, las anamnesis (incluidas las finalizadas) sin actividad durante ${days} días. ¿Activar?`,
            );
            if (ok) api.setSettings({ historyRetentionDays: days, confirmHistoryDeletion: true }).then(onSession, () => undefined);
            else e.target.value = "";
          }}
        >
          <option value="">Desactivada (no se elimina nada automáticamente)</option>
          {session.historyRetentionOptions.map((d) => (
            <option key={d} value={d}>
              Eliminar tras {d} días sin actividad
            </option>
          ))}
        </select>
      </section>
      <button className="link" onClick={onPrivacy}>
        Qué datos se usan y dónde
      </button>
    </main>
  );
}

export const STATUS_TEXT: Record<string, string> = {
  preparada: "Preparada",
  escuchando: "Escuchando",
  pausada: "Pausada",
  detenida: "Detenida",
  finalizada: "Finalizada",
};
