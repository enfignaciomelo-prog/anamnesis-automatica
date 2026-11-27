import type { OfflinePackage, OfflineSyncRequest } from "../shared/offline";
import type {
  ImportAnalysis,
  InterviewSnapshot,
  InterviewSummary,
  SessionInfo,
  SpeakerRole,
  TemplateDetail,
  TemplateSummary,
} from "../shared/types";
import { CancelledError, currentGeneration, endSession, noteActivity, signal, trackSave } from "./session";

export interface TemplateBody {
  name: string;
  sections: {
    id?: string;
    title: string;
    fields: {
      id?: string;
      label: string;
      hint?: string;
      concept?: string | null;
      critical?: boolean;
      manualOnly?: boolean;
      target?: unknown;
    }[];
  }[];
  note?: string;
  baseVersion?: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_ERRORS = new Set(["sin_sesion", "sesion_vencida", "bloqueo_inactividad"]);

/**
 * Llamada a la API ligada a la generación de sesión actual: si la sesión
 * termina mientras espera, la respuesta se descarta (CancelledError).
 */
async function raw(path: string, init: RequestInit): Promise<Response> {
  const g = currentGeneration();
  let res: Response;
  try {
    res = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store", signal: init.signal ?? signal() });
  } catch (e) {
    if (g !== currentGeneration() || (e as Error)?.name === "AbortError") throw new CancelledError();
    throw new ApiError(0, "red", "Sin conexión con el servidor. Lo que no se guardó puede perderse; intenta de nuevo.");
  }
  if (g !== currentGeneration()) throw new CancelledError();
  return res;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const g = currentGeneration();
  const res = await raw(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (g !== currentGeneration()) throw new CancelledError();
  if (!res.ok) {
    if (res.status === 401 && SESSION_ERRORS.has(data.error) && path !== "/api/session") {
      void endSession(data.error, true);
      throw new CancelledError();
    }
    throw new ApiError(res.status, data.error ?? "error", data.message ?? "No se pudo completar la acción.");
  }
  if (path !== "/api/session") noteActivity();
  return data as T;
}

/** Cambios que se guardan en el servidor: muestran Guardando / Guardado / Error al guardar. */
const save = <T>(method: string, path: string, body?: unknown) => trackSave(call<T>(method, path, body));

export interface ListFilter {
  desde?: string;
  hasta?: string;
  estado?: "" | "borrador" | "revisada";
}

export const api = {
  health: () => call<{ ok: boolean; demo: boolean; auth: "demo" | "cuentas" }>("GET", "/api/health"),
  session: () => call<SessionInfo>("GET", "/api/session"),
  demoLogin: (perfil: "demo-a" | "demo-b") =>
    call<{ ok: true }>("POST", "/api/demo/session", { perfil }).then(() => call<SessionInfo>("GET", "/api/session")),
  setSettings: (patch: { historyRetentionDays?: number | null; confirmHistoryDeletion?: boolean; idleMinutes?: number }) =>
    save<SessionInfo>("PATCH", "/api/settings", patch),
  list: (f: ListFilter = {}) => {
    const q = new URLSearchParams();
    if (f.desde) q.set("desde", f.desde);
    if (f.hasta) q.set("hasta", f.hasta);
    if (f.estado) q.set("estado", f.estado);
    return call<InterviewSummary[]>("GET", `/api/interviews${q.size ? `?${q}` : ""}`);
  },
  create: (templateId?: string) => save<InterviewSnapshot>("POST", "/api/interviews", { templateId }),
  templates: () => call<TemplateSummary[]>("GET", "/api/templates"),
  template: (id: string, version?: number) =>
    call<TemplateDetail>("GET", `/api/templates/${id}${version ? `?version=${version}` : ""}`),
  createTemplate: (body: TemplateBody) => save<TemplateDetail>("POST", "/api/templates", body),
  duplicateTemplate: (fromId: string) => save<TemplateDetail>("POST", "/api/templates", { fromId }),
  saveTemplate: (id: string, body: TemplateBody) => save<TemplateDetail>("PUT", `/api/templates/${id}`, body),
  deleteTemplate: (id: string) => save<{ ok: true }>("DELETE", `/api/templates/${id}`),
  confirmImport: (importId: string, body: TemplateBody) =>
    save<TemplateDetail>("POST", `/api/templates/import/${importId}/confirm`, body),
  importFile: async (file: File): Promise<ImportAnalysis> => {
    const g = currentGeneration();
    const res = await raw("/api/templates/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (g !== currentGeneration()) throw new CancelledError();
    if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? "No se pudo importar el archivo.");
    noteActivity();
    return data as ImportAnalysis;
  },
  remove: (id: string) => save<{ ok: true }>("DELETE", `/api/interviews/${id}`),
  consent: (id: string, givenBy: "paciente" | "representante") =>
    save<InterviewSnapshot>("POST", `/api/interviews/${id}/consent`, { givenBy }),
  command: (
    id: string, command: "iniciar" | "pausar" | "reanudar" | "detener", reason?: string,
    capture?: { captureId: string; sampleRate: number },
  ) => save<InterviewSnapshot>("POST", `/api/interviews/${id}/command`, { command, reason, ...capture }),
  audio: async (id: string, capture: string, sequence: number, bytes: ArrayBuffer, abort: AbortSignal) => {
    const response = await raw(`/api/interviews/${id}/audio?captura=${capture}&secuencia=${sequence}`, {
      method: "POST",
      body: bytes,
      headers: { "Content-Type": "application/octet-stream" },
      signal: abort,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 && SESSION_ERRORS.has(data.error)) void endSession(data.error, true);
      throw new ApiError(response.status, data.error ?? "audio", data.message ?? "Se interrumpió el audio.");
    }
  },
  setRole: (id: string, speaker: number, role: SpeakerRole) =>
    save<InterviewSnapshot>("POST", `/api/interviews/${id}/speakers`, { speaker, role }),
  saveDraft: (id: string, fieldId: string, value: string) =>
    save<{ savedAt: string }>("POST", `/api/interviews/${id}/fields/${fieldId}/draft`, { value }),
  confirm: (id: string, fieldId: string, value: string | null) =>
    save<InterviewSnapshot>("POST", `/api/interviews/${id}/fields/${fieldId}/confirm`, { value }),
  notReported: (id: string, fieldId: string) =>
    save<InterviewSnapshot>("POST", `/api/interviews/${id}/fields/${fieldId}/no-referido`, {}),
  finalize: (id: string, attested: boolean) => save<InterviewSnapshot>("POST", `/api/interviews/${id}/finalize`, { attested }),
};

// ---- Modo sin conexión ----

export const offlineApi = {
  package: () => call<OfflinePackage>("GET", "/api/offline/package"),
  /** Envío de un borrador. Lanza si no hay conexión; devuelve el estado HTTP para conflictos. */
  send: async (body: OfflineSyncRequest) => {
    const g = currentGeneration();
    const res = await raw("/api/offline/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (g !== currentGeneration()) throw new CancelledError();
    if (res.ok) noteActivity();
    return { ok: res.ok, status: res.status, body: data };
  },
};

// ---- Cuentas (Better Auth, rutas /api/auth/*) ----

const AUTH_MESSAGES: Record<string, string> = {
  EMAIL_NOT_VERIFIED: "Primero verifica tu correo: revisa tu bandeja de entrada.",
  INVALID_EMAIL_OR_PASSWORD: "Correo o contraseña incorrectos.",
  USER_ALREADY_EXISTS: "No se pudo crear la cuenta con ese correo.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "No se pudo crear la cuenta con ese correo.",
  PASSWORD_TOO_SHORT: "La contraseña debe tener al menos 10 caracteres.",
  PASSWORD_TOO_LONG: "La contraseña es demasiado larga.",
  INVALID_EMAIL: "El correo no es válido.",
  INVALID_TOKEN: "El enlace no es válido o ya venció. Pide uno nuevo.",
};

async function authCall(path: string, body: unknown) {
  const res = await raw(`/api/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(data.code ?? data.error ?? "");
    throw new ApiError(
      res.status,
      code,
      AUTH_MESSAGES[code] ?? (res.status === 429 ? "Demasiados intentos. Espera un minuto." : "No se pudo completar la acción."),
    );
  }
  return data;
}

export const accounts = {
  signUp: (name: string, email: string, password: string) =>
    authCall("/sign-up/email", { name, email, password, callbackURL: "/?verificado=1" }),
  signIn: (email: string, password: string) => authCall("/sign-in/email", { email, password, rememberMe: false }),
  requestReset: (email: string) => authCall("/request-password-reset", { email, redirectTo: "/restablecer" }),
  resetPassword: (token: string, newPassword: string) => authCall("/reset-password", { token, newPassword }),
};

/** Pausa al pasar a segundo plano; `keepalive` permite enviarla mientras la página se oculta. */
export function pauseInBackground(id: string, captureId?: string) {
  try {
    void fetch(`/api/interviews/${id}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "pausar", reason: "segundo_plano", captureId }),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    /* sin conexión: el servidor pausará por desconexión */
  }
}
