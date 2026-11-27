import WebSocket, { type ClientOptions } from "ws";
import { z } from "zod";
import { HttpError } from "../http";
import type { TranscriptionHandlers, TranscriptionSource } from "./source";

export const MAX_AUDIO_BYTES = 64 * 1024;
export type ConnectDeepgram = (url: URL, options: ClientOptions) => WebSocket;

export interface AudioCapture {
  id: string;
  rate: number;
}

const word = z.object({
  word: z.string(),
  punctuated_word: z.string().optional(),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
  speaker: z.number().int().nonnegative().max(100).optional(),
});
const result = z.object({
  type: z.literal("Results"),
  is_final: z.boolean(),
  start: z.number().finite().nonnegative(),
  duration: z.number().finite().nonnegative().optional(),
  channel: z.object({
    alternatives: z.array(z.object({ transcript: z.string(), words: z.array(word).optional() })).min(1),
  }),
});

export class DeepgramSource implements TranscriptionSource {
  readonly kind = "deepgram" as const;
  private socket?: WebSocket;
  private ready?: Promise<boolean>;
  private resolveClosed?: () => void;
  private closed = false;
  private closing = false;
  private sequence = 0;
  private lastFinalStart = -1;
  private idle?: NodeJS.Timeout;

  constructor(
    readonly capture: AudioCapture,
    private key: string,
    private handlers: TranscriptionHandlers,
    private offset: number,
    private firstSpeaker: number,
    private onFailure: () => void,
    private connect: ConnectDeepgram = (url, options) => new WebSocket(url, options),
  ) {}

  start() {
    const url = new URL("wss://api.deepgram.com/v1/listen");
    url.search = new URLSearchParams({
      model: "nova-3",
      language: "es-419",
      encoding: "linear16",
      sample_rate: String(this.capture.rate),
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      diarize: "true",
      mip_opt_out: "true",
    }).toString();
    this.ready = new Promise((resolve) => {
      const socket = this.connect(url, {
        headers: { Authorization: `Token ${this.key}` },
        handshakeTimeout: 6000,
        maxPayload: 256 * 1024,
        perMessageDeflate: false,
      });
      this.socket = socket;
      socket.once("open", () => {
        this.armIdle();
        resolve(true);
      });
      socket.on("message", (data, binary) => {
        if (!binary && !this.closed) this.handle(data.toString());
      });
      socket.on("close", () => {
        resolve(false);
        if (this.closing) this.resolveClosed?.();
        else this.fail();
      });
      socket.on("error", () => {
        resolve(false);
        if (this.closing) this.resolveClosed?.();
        else this.fail();
      });
    });
    // Una conexión puede fallar antes del primer POST de audio.
    void this.ready.catch(() => this.fail());
  }

  async send(seq: number, pcm: Buffer) {
    if (!(await this.ready) || this.closed || this.closing || this.socket?.readyState !== WebSocket.OPEN)
      throw new HttpError(409, "captura_inactiva", "La escucha se interrumpió. Reanuda para conectar el micrófono.");
    if (seq < this.sequence) return;
    if (seq !== this.sequence || this.socket.bufferedAmount > MAX_AUDIO_BYTES) {
      this.fail();
      throw new HttpError(409, "audio_interrumpido", "Se interrumpió el envío del audio. Reanuda la escucha.");
    }
    this.sequence++;
    this.socket.send(pcm, { binary: true }, (err) => {
      if (err && !this.closing) this.fail();
    });
    this.armIdle();
  }

  pause() { this.stop(); }
  resume() { /* El servicio crea una conexión nueva con la captura actual. */ }

  async finish() {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) {
      this.stop();
      return false;
    }
    this.closing = true;
    clearTimeout(this.idle);
    let completed = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3500);
      this.resolveClosed = () => {
        clearTimeout(timer);
        resolve();
      };
      this.socket!.once("close", (code) => { completed = code === 1000; });
      this.socket!.send(JSON.stringify({ type: "CloseStream" }), (err) => {
        if (err) this.resolveClosed?.();
      });
    });
    this.stop();
    return completed;
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    this.resolveClosed?.();
    this.socket?.terminate();
  }

  private fail() {
    if (this.closed) return;
    this.stop();
    this.onFailure();
  }

  private armIdle() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.fail(), 7500);
    this.idle.unref();
  }

  private handle(raw: string) {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return; }
    const parsed = result.safeParse(json);
    if (!parsed.success) return;
    const { channel, start, duration = 0, is_final } = parsed.data;
    const { transcript, words = [] } = channel.alternatives[0];
    if (!is_final) {
      this.handlers.onInterim(this.firstSpeaker + (words[0]?.speaker ?? 0), transcript);
      return;
    }
    if (start <= this.lastFinalStart || !transcript.trim()) return;
    this.lastFinalStart = start;
    this.handlers.onInterim(0, "");
    const unknown = this.firstSpeaker + 101;
    if (!words.length) {
      this.handlers.onFinal({ speaker: unknown, start: this.offset + start, end: this.offset + start + duration, text: transcript });
      return;
    }
    // Cada grupo de palabras contiguas mantiene la etiqueta del proveedor.
    // Una conexión nueva usa etiquetas nuevas: el profesional asigna el rol.
    let group: { speaker: number; start: number; end: number; words: string[] } | undefined;
    const emit = () => {
      if (group?.words.length)
        this.handlers.onFinal({
          speaker: group.speaker,
          start: this.offset + group.start,
          end: this.offset + group.end,
          text: group.words.join(" "),
        });
    };
    for (const w of words) {
      const speaker = w.speaker === undefined ? unknown : this.firstSpeaker + w.speaker;
      if (!group || group.speaker !== speaker) {
        emit();
        group = { speaker, start: w.start, end: w.end, words: [] };
      }
      group.words.push(w.punctuated_word || w.word);
      group.end = Math.max(group.end, w.end);
    }
    emit();
  }
}
