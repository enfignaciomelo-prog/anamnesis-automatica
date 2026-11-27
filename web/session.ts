/**
 * Sesión en el navegador: limpieza, vencimiento y propagación entre pestañas.
 *
 * - El servidor decide el vencimiento (corte 23:59 America/Santiago e
 *   inactividad); aquí solo se anticipa con la hora del servidor, no la del equipo.
 * - Cada petición pertenece a una «generación» de sesión. Al cerrar o vencer la
 *   sesión, la generación cambia: las peticiones pendientes se cancelan y una
 *   respuesta tardía se descarta en vez de volver a mostrar datos.
 * - Los datos clínicos viven solo en memoria. La limpieza termina reemplazando
 *   la página (location.replace), que descarta toda la memoria y evita que
 *   «Atrás» muestre la pantalla anterior.
 * - No se promete borrado puntual con la aplicación cerrada: al reabrirla se
 *   comprueba la sesión antes de mostrar datos clínicos.
 */
import { useSyncExternalStore } from "react";
import type { SessionInfo } from "../shared/types";

export class CancelledError extends Error {
  constructor() {
    super("cancelada");
    this.name = "CancelledError";
  }
}

export type SaveState =
  | { kind: "inactivo" }
  | { kind: "guardando" }
  | { kind: "guardado"; at: Date }
  | { kind: "error"; message: string };

interface State {
  save: SaveState;
  warning: string | null;
}

let gen = 0;
let controller = new AbortController();
let state: State = { save: { kind: "inactivo" }, warning: null };
const listeners = new Set<() => void>();
const flushers = new Set<() => Promise<void>>();
const stoppers = new Set<() => void>();
let session: SessionInfo | null = null;
let clockDelta = 0; // horaServidor - horaEquipo, para no depender del reloj del dispositivo
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let warnTimer: ReturnType<typeof setTimeout> | null = null;
let ending = false;

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("aa-sesion") : null;
channel?.addEventListener("message", (e) => {
  // En las demás pestañas el motivo es siempre «otra pestaña».
  if ((e as MessageEvent).data?.type === "fin") void endSession("otra_pestana", false);
});

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useSessionState() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function currentGeneration() {
  return gen;
}
export function signal() {
  return controller.signal;
}

/** Registra algo que debe detenerse al cerrar sesión (canales en vivo, micrófono). */
export function onEnd(stop: () => void) {
  stoppers.add(stop);
  return () => stoppers.delete(stop);
}

/** Registra un guardado pendiente que se intenta antes del corte. */
export function registerFlush(f: () => Promise<void>) {
  flushers.add(f);
  return () => flushers.delete(f);
}

export async function trackSave<T>(p: Promise<T>): Promise<T> {
  set({ save: { kind: "guardando" } });
  try {
    const v = await p;
    // Solo se informa «Guardado» con la confirmación del servidor.
    set({ save: { kind: "guardado", at: new Date() } });
    return v;
  } catch (e) {
    if (!(e instanceof CancelledError))
      set({ save: { kind: "error", message: e instanceof Error ? e.message : "No se pudo guardar." } });
    throw e;
  }
}

function serverNow() {
  return Date.now() + clockDelta;
}

/** Actualiza la sesión conocida y programa el vencimiento con la hora del servidor. */
export function setSession(s: SessionInfo | null) {
  session = s;
  if (expiryTimer) clearTimeout(expiryTimer);
  if (warnTimer) clearTimeout(warnTimer);
  if (!s) return;
  clockDelta = Date.parse(s.serverTime) - Date.now();
  scheduleExpiry();
}

/** Tras una acción exitosa, el bloqueo por inactividad se aleja. */
export function noteActivity() {
  if (!session) return;
  const idleUntil = serverNow() + session.idleMinutes * 60_000;
  session = { ...session, expiresAt: new Date(Math.min(Date.parse(session.cutoffAt), idleUntil)).toISOString() };
  scheduleExpiry();
}

function scheduleExpiry() {
  if (!session) return;
  if (expiryTimer) clearTimeout(expiryTimer);
  if (warnTimer) clearTimeout(warnTimer);
  const exp = Date.parse(session.expiresAt);
  const cutoff = Date.parse(session.cutoffAt);
  const inMs = Math.max(0, exp - serverNow());
  // Al vencer se consulta al servidor; si no responde, se limpia igual.
  expiryTimer = setTimeout(() => void verify("vencimiento"), Math.min(inMs + 500, 2 ** 31 - 1));
  const warnIn = cutoff - 5 * 60_000 - serverNow();
  if (warnIn > 0) warnTimer = setTimeout(() => void preCutoff(), Math.min(warnIn, 2 ** 31 - 1));
  else if (cutoff - serverNow() > 0) void preCutoff();
}

async function preCutoff() {
  set({
    warning:
      "A las 23:59 (hora de Chile) vence la sesión y se limpian los datos de este dispositivo. Intentando guardar tus borradores…",
  });
  const results = await Promise.allSettled([...flushers].map((f) => f()));
  const failed = results.filter((r) => r.status === "rejected").length;
  set({
    warning: failed
      ? `A las 23:59 vence la sesión. ${failed} borrador(es) no se pudieron guardar en el servidor: lo que no se guardó puede perderse cuando se limpie el dispositivo.`
      : "A las 23:59 (hora de Chile) vence la sesión. Tus borradores están guardados en el servidor.",
  });
}

/** Comprueba la sesión con el servidor; si venció, limpia. */
export async function verify(reason: string): Promise<SessionInfo | null> {
  if (ending) return null;
  try {
    const res = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      let why: string = data.error ?? reason;
      // Otra petición pudo vencer la sesión primero: se explica la causa real.
      if (why === "sin_sesion" && session && serverNow() >= Date.parse(session.cutoffAt)) why = "sesion_vencida";
      else if (why === "sin_sesion" && session && serverNow() >= Date.parse(session.expiresAt)) why = "bloqueo_inactividad";
      await endSession(why, true);
      return null;
    }
    if (!res.ok) throw new Error(String(res.status));
    const s = (await res.json()) as SessionInfo;
    setSession(s);
    return s;
  } catch {
    // Sin conexión: si según la hora del servidor la sesión ya venció, se limpia igual.
    if (session && serverNow() >= Date.parse(session.expiresAt)) await endSession("vencimiento_sin_conexion", true);
    return session;
  }
}

/**
 * Termina la sesión en este navegador: detiene todo, cancela peticiones,
 * limpia almacenamiento y reemplaza la página.
 */
export async function endSession(reason: string, broadcast: boolean, callServer = false) {
  if (ending) return;
  ending = true;
  gen++;
  controller.abort();
  controller = new AbortController();
  for (const s of stoppers) {
    try {
      s();
    } catch {
      /* continuar la limpieza */
    }
  }
  stoppers.clear();
  flushers.clear();
  if (expiryTimer) clearTimeout(expiryTimer);
  if (warnTimer) clearTimeout(warnTimer);
  session = null;
  if (broadcast) channel?.postMessage({ type: "fin", reason });
  if (callServer) {
    try {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin", keepalive: true });
    } catch {
      /* sin conexión: el servidor igual vence la sesión */
    }
  }
  await clearLocalData();
  location.replace(`/?salida=${encodeURIComponent(reason)}`);
}

/** Borra almacenamiento local (incluido el de versiones anteriores) y cachés no públicas. */
export async function clearLocalData() {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* almacenamiento no disponible */
  }
  try {
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise<void>((done) => {
            if (!d.name) return done();
            const r = indexedDB.deleteDatabase(d.name);
            r.onsuccess = r.onerror = r.onblocked = () => done();
          }),
      ),
    );
  } catch {
    /* sin IndexedDB */
  }
  try {
    if (self.caches) {
      for (const k of await caches.keys()) {
        // Solo se conserva la estructura pública de la aplicación.
        if (!k.startsWith("aa-shell-")) await caches.delete(k);
        else {
          const c = await caches.open(k);
          for (const r of await c.keys()) if (new URL(r.url).pathname.startsWith("/api/")) await c.delete(r);
        }
      }
    }
  } catch {
    /* sin Cache Storage */
  }
}

/** Revalidaciones: al iniciar, al recuperar foco, al volver a ser visible y al reanudar. */
export function installLifecycleChecks(onRevalidated: (s: SessionInfo | null) => void) {
  const check = (why: string) => void verify(why).then(onRevalidated);
  window.addEventListener("focus", () => check("foco"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check("visible");
  });
  window.addEventListener("pageshow", (e) => {
    // Página restaurada desde la memoria del navegador: ocultar y revalidar antes de mostrar.
    if ((e as PageTransitionEvent).persisted) {
      document.documentElement.classList.add("revalidando");
      void verify("reanudar").then((s) => {
        if (s) document.documentElement.classList.remove("revalidando");
        onRevalidated(s);
      });
    }
  });
}
