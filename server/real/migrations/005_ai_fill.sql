-- Llenado asistido con Claude: estado de la última solicitud y último resultado
-- válido (propuestas ya validadas contra la transcripción, con sus respaldos).
-- Vive en la misma fila de la entrevista: hereda el dueño y RLS.
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS ai jsonb;
