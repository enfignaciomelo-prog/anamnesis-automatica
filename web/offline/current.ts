/**
 * Borradores sin conexión abiertos en esta pestaña. La clave vive solo aquí, en
 * memoria; se olvida al ocultar la página («Atrás», cambio de app que descarta
 * la página), al cerrar sesión, por inactividad y en el corte diario.
 */
import { useSyncExternalStore } from "react";
import { onEnd } from "../session";
import { IdbBackend } from "./idb";
import type { OfflineVault } from "./vault";

export const backend = new IdbBackend();
let vault: OfflineVault | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function setVault(v: OfflineVault | null) {
  if (vault && vault !== v) vault.lock();
  vault = v;
  emit();
}

export function lockVault() {
  setVault(null);
}

export function useVault() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => vault,
  );
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", lockVault);
  onEnd(lockVault);
}

/** Avisos entre pestañas (sin contenido): otra pestaña cambió o eliminó los borradores. */
export const offlineChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("aa-offline") : null;
