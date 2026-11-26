import type { InterviewSnapshot, InterviewSummary, SessionInfo, SpeakerRole } from "../shared/types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "red", "Sin conexión con el servidor. Revisa tu conexión e intenta de nuevo.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? "No se pudo completar la acción.");
  return data as T;
}

export const api = {
  session: () => call<SessionInfo>("GET", "/api/session"),
  demoLogin: (perfil: "demo-a" | "demo-b") => call<SessionInfo>("POST", "/api/demo/session", { perfil }),
  logout: () => call<{ ok: true }>("POST", "/api/logout", {}),
  setRetention: (retentionMinutes: number) => call<SessionInfo>("PATCH", "/api/settings", { retentionMinutes }),
  list: () => call<InterviewSummary[]>("GET", "/api/interviews"),
  create: () => call<InterviewSnapshot>("POST", "/api/interviews", {}),
  remove: (id: string) => call<{ ok: true }>("DELETE", `/api/interviews/${id}`),
  consent: (id: string, givenBy: "paciente" | "representante") =>
    call<InterviewSnapshot>("POST", `/api/interviews/${id}/consent`, { givenBy }),
  command: (id: string, command: "iniciar" | "pausar" | "reanudar" | "detener", reason?: string) =>
    call<InterviewSnapshot>("POST", `/api/interviews/${id}/command`, { command, reason }),
  setRole: (id: string, speaker: number, role: SpeakerRole) =>
    call<InterviewSnapshot>("POST", `/api/interviews/${id}/speakers`, { speaker, role }),
  confirm: (id: string, fieldId: string, value: string | null) =>
    call<InterviewSnapshot>("POST", `/api/interviews/${id}/fields/${fieldId}/confirm`, { value }),
  notReported: (id: string, fieldId: string) =>
    call<InterviewSnapshot>("POST", `/api/interviews/${id}/fields/${fieldId}/no-referido`, {}),
  finalize: (id: string, attested: boolean) =>
    call<InterviewSnapshot>("POST", `/api/interviews/${id}/finalize`, { attested }),
};

/** Pausa al pasar a segundo plano; `keepalive` permite enviarla mientras la página se oculta. */
export function pauseInBackground(id: string) {
  try {
    void fetch(`/api/interviews/${id}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "pausar", reason: "segundo_plano" }),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    /* sin conexión: el servidor pausará por desconexión */
  }
}
