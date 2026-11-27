// Modo sin conexión manual: tipos y textos compartidos entre servidor e interfaz.
//
// Excepción explícita a «datos clínicos solo en memoria»: los borradores manuales
// pueden guardarse cifrados (AES-GCM, Web Crypto) en IndexedDB del dispositivo,
// en un espacio separado por profesional, hasta el corte diario.

import type { Template } from "./types";

/** Texto exacto exigido por el responsable. */
export const OFFLINE_CUTOFF_NOTICE =
  "Los borradores guardados solo en este dispositivo se eliminan en el corte diario, aunque no se hayan sincronizado.";

export type LocalSyncStatus = "guardado_local" | "pendiente" | "sincronizado" | "error";

export const LOCAL_SYNC_LABEL: Record<LocalSyncStatus, string> = {
  guardado_local: "Guardado en este dispositivo",
  pendiente: "Pendiente de sincronizar",
  sincronizado: "Sincronizado con tu cuenta",
  error: "Error de sincronización",
};

/** Largo mínimo de la frase de desbloqueo local (no es la contraseña de la cuenta). */
export const OFFLINE_PASSPHRASE_MIN = 10;
export const OFFLINE_MAX_TEXT = 5000;
export const OFFLINE_MAX_DRAFTS = 50;

/** Paquete que el dispositivo descarga (con conexión) para trabajar sin ella. */
export interface OfflinePackage {
  professional: { id: string; name: string };
  templates: Template[];
  /** Corte diario de la sesión con la que se preparó el dispositivo. */
  cutoffAt: string;
  serverTime: string;
}

/** Envío idempotente de un borrador manual. */
export interface OfflineSyncRequest {
  /** Identificador del borrador generado en el dispositivo (UUID). */
  clientId: string;
  /** Revisión local; sube con cada cambio guardado en el dispositivo. */
  revision: number;
  templateId: string;
  templateVersion: number;
  /** Texto escrito por el profesional por campo; los campos ausentes quedan «No referido». */
  fields: Record<string, string>;
  createdAt: string;
}

export interface OfflineSyncResponse {
  status: "sincronizado";
  interviewId: string;
  revision: number;
  /** El servidor ya tenía esta revisión (reintento sin efectos). */
  duplicate: boolean;
}

export type OfflineConflictReason = "modificada_en_servidor" | "eliminada_en_servidor" | "finalizada" | "revision_distinta";

export const CONFLICT_TEXT: Record<OfflineConflictReason, string> = {
  modificada_en_servidor:
    "La anamnesis se modificó en tu cuenta después de la última sincronización. No se sobrescribió nada.",
  eliminada_en_servidor: "La anamnesis se eliminó de tu cuenta después de sincronizarla. No se volvió a crear.",
  revision_distinta: "Ya se sincronizó otra versión con el mismo número de revisión.",
  finalizada: "La anamnesis ya fue finalizada en tu cuenta. No se sobrescribió nada.",
};
