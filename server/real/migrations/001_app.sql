-- Anamnesis Automática: tablas de la aplicación.
-- Se ejecuta DESPUÉS de las migraciones de Better Auth (tabla "user").
-- Todo vive en el esquema "anamnesis" (no expuesto por la API de datos de
-- Supabase). RLS activado sin políticas: solo el dueño de las tablas (el rol
-- del servidor) puede leerlas; otros roles quedan bloqueados.

CREATE TABLE IF NOT EXISTS professional_settings (
  user_id            text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  retention_minutes  integer NOT NULL CHECK (retention_minutes > 0),
  idle_minutes       integer NOT NULL CHECK (idle_minutes > 0),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS interviews (
  id             uuid PRIMARY KEY,
  owner_id       text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title          text NOT NULL,
  status         text NOT NULL CHECK (status IN ('preparada','escuchando','pausada','detenida','finalizada')),
  template       jsonb NOT NULL,
  consent        jsonb,
  segments       jsonb NOT NULL DEFAULT '[]'::jsonb,
  speaker_roles  jsonb NOT NULL DEFAULT '{}'::jsonb,
  prof           jsonb NOT NULL DEFAULT '{}'::jsonb,
  pause_reason   text,
  created_at     timestamptz NOT NULL,
  last_activity  timestamptz NOT NULL,
  finalized_at   timestamptz
);
CREATE INDEX IF NOT EXISTS interviews_owner_created ON interviews (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS templates (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name        text NOT NULL,
  source      jsonb,
  versions    jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS templates_owner ON templates (owner_id, updated_at DESC);

-- Archivos originales de plantillas (formularios en blanco). Nunca audio.
CREATE TABLE IF NOT EXISTS files (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('docx','xlsx','pdf')),
  file_name   text NOT NULL,
  bytes       bytea NOT NULL CHECK (octet_length(bytes) <= 5242880),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_owner ON files (owner_id);

CREATE TABLE IF NOT EXISTS pending_imports (
  id             text PRIMARY KEY,
  owner_id       text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  file_id        text NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  analysis       jsonb NOT NULL,
  valid_targets  jsonb NOT NULL,
  expires_at     timestamptz NOT NULL
);

-- Actividad por sesión para el bloqueo por inactividad (exigido en servidor).
CREATE TABLE IF NOT EXISTS session_activity (
  session_id  text PRIMARY KEY,
  last_seen   timestamptz NOT NULL
);

ALTER TABLE professional_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification" ENABLE ROW LEVEL SECURITY;
