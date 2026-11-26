import { useEffect, useState } from "react";
import type { ImportAnalysis, InterviewSummary, SessionInfo, TemplateSummary } from "../shared/types";
import { api, ApiError } from "./api";
import { InterviewScreen } from "./Interview";
import { PrivacyScreen } from "./Privacy";
import { TemplateEditorScreen, TemplatesScreen } from "./Templates";

type View =
  | { name: "home" }
  | { name: "interview"; id: string }
  | { name: "privacy" }
  | { name: "templates" }
  | { name: "template"; id: string }
  | { name: "import"; analysis: ImportAnalysis };

export function App() {
  const [session, setSession] = useState<SessionInfo | null | undefined>(undefined);
  const [view, setView] = useState<View>({ name: "home" });

  useEffect(() => {
    api.session().then(setSession, () => setSession(null));
  }, []);

  if (session === undefined) return <main className="center muted">Cargando…</main>;
  if (view.name === "privacy") return <PrivacyScreen onBack={() => setView({ name: "home" })} />;
  if (!session)
    return <Welcome onLogin={setSession} onPrivacy={() => setView({ name: "privacy" })} />;
  if (view.name === "interview")
    return <InterviewScreen id={view.id} session={session} onExit={() => setView({ name: "home" })} />;
  if (view.name === "templates")
    return (
      <TemplatesScreen
        onBack={() => setView({ name: "home" })}
        onOpen={(id) => setView({ name: "template", id })}
        onImported={(analysis) => setView({ name: "import", analysis })}
      />
    );
  if (view.name === "template" || view.name === "import")
    return (
      <TemplateEditorScreen
        key={view.name === "template" ? view.id : view.analysis.importId}
        id={view.name === "template" ? view.id : undefined}
        analysis={view.name === "import" ? view.analysis : undefined}
        onBack={() => setView({ name: "templates" })}
        onSaved={(id) => setView({ name: "template", id })}
      />
    );
  return (
    <Home
      session={session}
      onSession={setSession}
      onOpen={(id) => setView({ name: "interview", id })}
      onPrivacy={() => setView({ name: "privacy" })}
      onTemplates={() => setView({ name: "templates" })}
    />
  );
}

export function DemoNotice() {
  return (
    <p className="demo-notice" role="note">
      Demostración con datos ficticios. No se activa el micrófono ni se envían datos a otros servicios.
    </p>
  );
}

function Welcome({ onLogin, onPrivacy }: { onLogin: (s: SessionInfo) => void; onPrivacy: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const login = (p: "demo-a" | "demo-b") =>
    api.demoLogin(p).then(onLogin, (e: ApiError) => setError(e.message));
  return (
    <main className="welcome">
      <header className="welcome-head">
        <h1>Anamnesis Automática</h1>
        <p className="lede">
          Escucha la entrevista, transcribe en español y propone cada campo con el fragmento que lo
          respalda. Tú revisas y confirmas.
        </p>
      </header>
      <DemoNotice />
      <section className="panel" aria-labelledby="perfiles">
        <h2 id="perfiles">Entrar a la demostración</h2>
        <p className="muted">
          Dos profesionales ficticios para comprobar que cada uno ve solo sus entrevistas. No se usan
          contraseñas en esta etapa.
        </p>
        <div className="stack">
          <button className="btn primary" onClick={() => login("demo-a")}>
            Entrar como Profesional Demo A
          </button>
          <button className="btn" onClick={() => login("demo-b")}>
            Entrar como Profesional Demo B
          </button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <button className="link" onClick={onPrivacy}>
        Qué datos se usan y dónde
      </button>
    </main>
  );
}

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.list().then(setList, (e: ApiError) => {
      if (e.status === 401) onSession(null);
      else setError(e.message);
    });
    api.templates().then(setTemplates, () => undefined);
  }, [onSession]);

  const create = () => api.create(templateId).then((s) => onOpen(s.id), (e: ApiError) => setError(e.message));

  return (
    <main className="home">
      <header className="home-head">
        <div>
          <h1>Entrevistas</h1>
          <p className="muted">{session.professional.name}</p>
        </div>
        <button className="btn small" onClick={() => api.logout().then(() => onSession(null))}>
          Salir
        </button>
      </header>
      {session.demo && <DemoNotice />}
      <label className="field-label" htmlFor="plantilla">
        Plantilla para la nueva entrevista
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
      {error && <p className="error" role="alert">{error}</p>}
      <section aria-label="Tus entrevistas">
        {list === null ? (
          <p className="muted">Cargando…</p>
        ) : list.length === 0 ? (
          <p className="empty">Aún no tienes entrevistas. Crea una para probar el flujo completo.</p>
        ) : (
          <ul className="interview-list">
            {list.map((i) => (
              <li key={i.id}>
                <button className="row-btn" onClick={() => onOpen(i.id)}>
                  <span>{i.title}</span>
                  <span className={`pill st-${i.status}`}>{STATUS_TEXT[i.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="ret">
        <h2 id="ret">Retención</h2>
        <label className="field-label" htmlFor="retencion">
          Las entrevistas se eliminan del servidor tras este tiempo sin actividad
        </label>
        <select
          id="retencion"
          value={session.retentionMinutes}
          onChange={(e) => api.setRetention(Number(e.target.value)).then(onSession)}
        >
          {session.retentionOptions.map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} minutos` : `${m / 60} ${m === 60 ? "hora" : "horas"}`}
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
