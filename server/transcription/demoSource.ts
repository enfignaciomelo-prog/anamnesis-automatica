/**
 * Fuente SIMULADA: reproduce el guion ficticio palabra por palabra, como lo
 * haría un servicio de transcripción en tiempo real. No usa micrófono.
 */
import type { ScriptLine } from "../demo/script";
import type { TranscriptionHandlers, TranscriptionSource } from "./source";

const WORD_MS = 260;
const GAP_MS = 700;

export class DemoSource implements TranscriptionSource {
  readonly kind = "demo" as const;
  private line = 0;
  private word = 0;
  private clock = 0; // segundos de entrevista transcurridos
  private lineStart = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ended = false;

  constructor(
    private script: ScriptLine[],
    private h: TranscriptionHandlers,
    private speed = 1,
  ) {}

  start() {
    this.running = true;
    this.schedule(0);
  }
  pause() {
    this.running = false;
    this.clear();
    // Lo provisional se descarta: al reanudar, la frase se repite completa.
    if (this.word > 0) {
      this.word = 0;
      this.h.onInterim(0, "");
    }
  }
  resume() {
    if (this.ended) return;
    this.running = true;
    this.schedule(0);
  }
  stop() {
    this.running = false;
    this.clear();
    if (!this.ended) {
      this.ended = true;
      this.h.onEnd();
    }
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    this.clear();
    this.timer = setTimeout(() => this.tick(), ms / this.speed);
  }

  private tick() {
    if (!this.running) return;
    const l = this.script[this.line];
    if (!l) {
      this.stop();
      return;
    }
    const words = l.text.split(" ");
    if (this.word === 0) this.lineStart = this.clock;
    this.word++;
    this.clock += WORD_MS / 1000;
    if (this.word < words.length) {
      this.h.onInterim(l.speaker, words.slice(0, this.word).join(" "));
      this.schedule(WORD_MS);
      return;
    }
    this.h.onInterim(l.speaker, "");
    this.h.onFinal({ speaker: l.speaker, text: l.text, start: round(this.lineStart), end: round(this.clock) });
    this.line++;
    this.word = 0;
    this.clock += GAP_MS / 1000;
    this.schedule(WORD_MS + GAP_MS);
  }
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}
