-- Permite distinguir un reintento del mismo número de revisión con otro contenido.
ALTER TABLE offline_sync ADD COLUMN IF NOT EXISTS request_hash text;
