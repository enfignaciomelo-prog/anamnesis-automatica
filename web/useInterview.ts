import { useCallback, useEffect, useRef, useState } from "react";
import type { InterimEvent, InterviewSnapshot } from "../shared/types";
import { pauseInBackground } from "./api";

export type Connection = "conectando" | "conectado" | "reconectando" | "sin_conexion";

/**
 * Estado en vivo de una entrevista. Todo queda en memoria: nada clínico se
 * guarda en el navegador. Al reconectar, el servidor envía el estado completo.
 */
export function useInterview(id: string, onDeleted: () => void) {
  const [snap, setSnap] = useState<InterviewSnapshot | null>(null);
  const [interim, setInterim] = useState<InterimEvent | null>(null);
  const [conn, setConn] = useState<Connection>("conectando");
  const statusRef = useRef<string | null>(null);
  const deletedRef = useRef(onDeleted);
  deletedRef.current = onDeleted;

  useEffect(() => {
    const es = new EventSource(`/api/interviews/${id}/events`, { withCredentials: true });
    es.addEventListener("open", () => setConn(navigator.onLine ? "conectado" : "sin_conexion"));
    es.addEventListener("error", () => setConn(navigator.onLine ? "reconectando" : "sin_conexion"));
    es.addEventListener("snapshot", (e) => {
      const s = JSON.parse((e as MessageEvent).data) as InterviewSnapshot;
      statusRef.current = s.status;
      setSnap(s);
      setConn("conectado");
      if (s.status !== "escuchando") setInterim(null);
    });
    es.addEventListener("interim", (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as InterimEvent;
      setInterim(ev.text ? ev : null);
    });
    es.addEventListener("deleted", () => {
      es.close();
      deletedRef.current();
    });
    const offline = () => setConn("sin_conexion");
    const online = () => setConn("reconectando");
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);

    // iPhone: llamadas, bloqueo de pantalla o cambio de app ocultan la página.
    // No se promete escucha en segundo plano: se pausa.
    const hide = () => {
      if (document.visibilityState === "hidden" && statusRef.current === "escuchando") pauseInBackground(id);
    };
    const pagehide = () => {
      if (statusRef.current === "escuchando") pauseInBackground(id);
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", pagehide);
    return () => {
      es.close();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", pagehide);
    };
  }, [id]);

  const apply = useCallback((s: InterviewSnapshot) => {
    statusRef.current = s.status;
    setSnap(s);
  }, []);

  return { snap, interim, conn, apply };
}
