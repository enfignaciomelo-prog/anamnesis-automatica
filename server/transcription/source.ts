import type { Segment } from "../../shared/types";

/**
 * Fuente de transcripción. La demo y Deepgram (etapa 3) implementan lo mismo:
 * texto provisional (cambia mientras se habla) y segmentos definitivos.
 */
export interface TranscriptionHandlers {
  onInterim(speaker: number, text: string): void;
  onFinal(segment: Omit<Segment, "id">): void;
  onEnd(): void;
}

export interface TranscriptionSource {
  readonly kind: "demo" | "deepgram";
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
}
