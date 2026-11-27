-- Sincronización idempotente de borradores escritos sin conexión.
-- Un borrador del dispositivo (client_id) corresponde a una sola anamnesis del
-- mismo profesional. Sin clave foránea a interviews a propósito: si la anamnesis
-- se elimina, el vínculo permanece y el servidor informa el conflicto en vez de
-- volver a crearla en silencio.
CREATE TABLE IF NOT EXISTS offline_sync (
  owner_id      text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  client_id     uuid NOT NULL,
  interview_id  uuid NOT NULL,
  revision      integer NOT NULL CHECK (revision > 0),
  content_hash  text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, client_id)
);
ALTER TABLE offline_sync ENABLE ROW LEVEL SECURITY;
