/**
 * Registro sin contenido clínico: solo método, ruta normalizada, estado y
 * duración. Nunca cuerpos, parámetros de consulta, textos ni identificadores.
 */
export type LogSink = (line: string) => void;

let sink: LogSink = (l) => process.stdout.write(l + "\n");

export function setLogSink(s: LogSink) {
  sink = s;
}

export function logRequest(method: string, route: string, status: number, ms: number) {
  sink(JSON.stringify({ t: new Date().toISOString(), method, route, status, ms: Math.round(ms) }));
}

export function logEvent(event: string, extra: Record<string, string | number | boolean> = {}) {
  sink(JSON.stringify({ t: new Date().toISOString(), event, ...extra }));
}

/** Para errores: solo el nombre y un código, nunca el mensaje (podría contener datos). */
export function logError(where: string, err: unknown) {
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown })?.code;
  // En pruebas se puede ver el mensaje técnico (nunca en producción: podría contener datos).
  if (process.env.LOG_ERROR_DETAIL === "1" && err instanceof Error)
    sink(JSON.stringify({ t: new Date().toISOString(), event: "error_detail", where, message: err.message.slice(0, 300) }));
  sink(JSON.stringify({ t: new Date().toISOString(), event: "error", where, name, code: String(code ?? "") }));
}
