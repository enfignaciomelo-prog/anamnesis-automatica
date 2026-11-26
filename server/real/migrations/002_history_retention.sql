-- La eliminación automática del historial deja de heredar un plazo de la demo:
-- queda desactivada (NULL) salvo que el profesional la configure explícitamente.
-- Es independiente de la limpieza local del dispositivo.
ALTER TABLE professional_settings
  ADD COLUMN IF NOT EXISTS history_retention_days integer
  CHECK (history_retention_days IS NULL OR history_retention_days > 0);
ALTER TABLE professional_settings DROP COLUMN IF EXISTS retention_minutes;
