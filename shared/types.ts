// Tipos compartidos entre servidor e interfaz.

export type FieldId = string;

export interface TemplateField {
  id: FieldId;
  label: string;
  hint?: string;
  /** Campos críticos (medicamentos, dosis, alergias) siempre requieren revisión. */
  critical?: boolean;
  /** Solo lo escribe el profesional; la extracción nunca lo llena. */
  manualOnly?: boolean;
  /** Texto usado cuando el paciente niega explícitamente, p. ej. "alergias a medicamentos". */
  negationLabel?: string;
  /** Tipo de dato clínico que el extractor reconoce (ver shared/concepts.ts). */
  concept?: string;
  /** Dónde va el valor en el archivo original de la plantilla importada. */
  target?: FieldTarget;
}

export type FieldTarget =
  | { kind: "bookmark"; name: string }
  | { kind: "paragraph"; index: number; text: string }
  | { kind: "cell"; sheet: string; cell: string };

export type SourceKind = "docx" | "xlsx" | "pdf";

export interface TemplateSource {
  kind: SourceKind;
  fileName: string;
  /** Identificador opaco del archivo original (solo accesible por su dueño). */
  fileId: string;
  /** Campos obtenidos por OCR: requieren revisión manual. */
  ocr?: boolean;
}

export interface TemplateSection {
  id: string;
  title: string;
  fields: TemplateField[];
}

export interface Template {
  id: string;
  name: string;
  version: number;
  sections: TemplateSection[];
  source?: TemplateSource;
}

export interface TemplateSummary {
  id: string;
  name: string;
  version: number;
  builtIn: boolean;
  sourceKind: SourceKind | null;
  updatedAt: string;
  fieldCount: number;
}

export interface TemplateDetail extends Template {
  builtIn: boolean;
  versions: { version: number; createdAt: string; note: string }[];
}

/** Propuesta de un campo detectado en un archivo importado. */
export interface ImportCandidate {
  key: string;
  label: string;
  section: string;
  concept: string | null;
  target: FieldTarget | null;
  include: boolean;
  /** Motivo por el que no se puede mapear (p. ej., la celda tiene fórmula). */
  problem?: string;
  origin: "marcador" | "etiqueta" | "celda" | "nombre_definido" | "pdf" | "ocr";
}

export interface ImportAnalysis {
  importId: string;
  fileName: string;
  kind: SourceKind;
  suggestedName: string;
  candidates: ImportCandidate[];
  sheets: string[];
  warnings: string[];
  ocr: boolean;
}

export type SpeakerRole = "profesional" | "paciente" | "acompanante" | "sin_asignar";

export interface Segment {
  id: string;
  /** Etiqueta del proveedor de transcripción (diarización). Nunca implica identidad. */
  speaker: number;
  text: string;
  /** Segundos desde el inicio de la escucha. */
  start: number;
  end: number;
}

export type Classification = "actual" | "historico" | "negado" | "familiar";

export type ReviewReason =
  | "critico"
  | "dosis"
  | "contradiccion"
  | "incertidumbre"
  | "acompanante"
  | "hablante_sin_asignar"
  | "nueva_informacion";

export interface Evidence {
  segmentId: string;
  /** Fragmento literal de la transcripción. */
  quote: string;
  start: number;
  /** Pregunta del profesional que da contexto a una respuesta breve. */
  context?: { segmentId: string; quote: string };
}

export interface ProposalItem {
  id: string;
  fieldId: FieldId;
  value: string;
  classification: Classification;
  evidence: Evidence[];
  reasons: ReviewReason[];
  /** El hablante se corrigió dentro del mismo segmento. */
  corrected?: { discardedQuote: string };
  /** Clave para detectar contradicciones (p. ej. nombre del medicamento). */
  key?: string;
}

export type FieldStatus = "no_referido" | "propuesto" | "requiere_revision" | "confirmado";

export interface FieldState {
  fieldId: FieldId;
  status: FieldStatus;
  /** Texto propuesto a partir de la transcripción (si no hay texto del profesional). */
  proposedValue: string | null;
  /** Texto escrito o confirmado por el profesional. Nunca se sobrescribe automáticamente. */
  professionalValue: string | null;
  editedByProfessional: boolean;
  /** Texto en edición autoguardado en el servidor, aún no confirmado. */
  draftValue: string | null;
  items: ProposalItem[];
  /** Ítems aparecidos después de la confirmación del profesional. */
  newItemIds: string[];
  reasons: ReviewReason[];
}

export type InterviewStatus = "preparada" | "escuchando" | "pausada" | "detenida" | "finalizada";

export interface Consent {
  at: string;
  givenBy: "paciente" | "representante";
}

export interface InterviewSummary {
  id: string;
  createdAt: string;
  /** Última modificación guardada. */
  updatedAt: string;
  status: InterviewStatus;
  templateName: string;
  title: string;
}

export interface InterviewSnapshot extends InterviewSummary {
  template: Template;
  consent: Consent | null;
  segments: Segment[];
  speakerRoles: Record<number, SpeakerRole>;
  fields: Record<FieldId, FieldState>;
  pauseReason: string | null;
  finalizedAt: string | null;
  demo: boolean;
  /** Eliminación automática del servidor; null si el profesional no la configuró. */
  autoDeleteAt: string | null;
}

export interface InterimEvent {
  speaker: number;
  text: string;
}

export interface SessionInfo {
  professional: { id: string; name: string; email?: string };
  demo: boolean;
  /** "demo" (perfiles ficticios) o "cuentas" (correo y contraseña). */
  authMode: "demo" | "cuentas";
  /** Eliminación automática del historial (días sin actividad); null = desactivada. */
  historyRetentionDays: number | null;
  historyRetentionOptions: number[];
  idleMinutes: number;
  idleOptions: number[];
  /** Corte diario (23:59 America/Santiago) de esta sesión. Lo exige el servidor. */
  cutoffAt: string;
  /** Vencimiento efectivo: el menor entre el corte y el bloqueo por inactividad. */
  expiresAt: string;
  serverTime: string;
}

export const STATUS_LABEL: Record<FieldStatus, string> = {
  no_referido: "No referido",
  propuesto: "Propuesto",
  requiere_revision: "Requiere revisión",
  confirmado: "Confirmado",
};

export const REASON_LABEL: Record<ReviewReason, string> = {
  critico: "Dato crítico: verificar con el paciente",
  dosis: "Verificar medicamento, dosis y frecuencia",
  contradiccion: "Hay versiones distintas en la entrevista",
  incertidumbre: "La respuesta expresa duda",
  acompanante: "Lo dijo un acompañante, no el paciente",
  hablante_sin_asignar: "Falta indicar quién habla",
  nueva_informacion: "Hay información nueva después de tu confirmación",
};

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  actual: "Actual",
  historico: "Histórico",
  negado: "Negado",
  familiar: "Familiar",
};

export const ROLE_LABEL: Record<SpeakerRole, string> = {
  profesional: "Profesional",
  paciente: "Paciente",
  acompanante: "Acompañante",
  sin_asignar: "Sin asignar",
};
