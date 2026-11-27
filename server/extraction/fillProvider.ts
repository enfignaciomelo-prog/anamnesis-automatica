/**
 * Proveedor del llenado asistido. El real (Claude) vive en server/real/anthropicFill.ts
 * y solo se carga con CLAUDE_FILL=true en modo cuentas; las pruebas usan uno simulado.
 */
import type { Segment, SpeakerRole, Template } from "../../shared/types";

export interface FillRequest {
  template: Template;
  segments: Segment[];
  roles: Record<number, SpeakerRole>;
}

export interface FillProvider {
  /** Modelo informado al profesional (p. ej., «claude-opus-5-5»). */
  readonly model: string;
  /** Devuelve el JSON ya interpretado (sin validar). Debe respetar `signal`. */
  fill(req: FillRequest, signal: AbortSignal): Promise<unknown>;
}

/** Error del proveedor con un mensaje apto para el profesional (sin contenido clínico). */
export class FillProviderError extends Error {
  constructor(
    public userMessage: string,
    public code: string,
  ) {
    super(code);
    this.name = "FillProviderError";
  }
}
