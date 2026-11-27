import { api } from "./api";

export class Microphone {
  readonly id = crypto.randomUUID();
  private context: AudioContext;
  private stream?: MediaStream;
  private worklet?: AudioWorkletNode;
  private abort = new AbortController();
  private queue = Promise.resolve();
  private queued = 0;
  private sequence = 0;
  private closing = false;
  private dead = false;

  constructor(private interviewId: string, private onInterrupt: (text: string) => void) {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext)
      throw new Error("El micrófono requiere un navegador compatible y una conexión HTTPS.");
    this.context = new AudioContext({ sampleRate: 48000 });
  }

  get rate() { return this.context.sampleRate; }

  async prepare(recordConsent?: () => Promise<unknown>) {
    const resume = this.context.resume();
    // Safari requiere iniciar el contexto dentro del gesto de la persona.
    await Promise.all([resume, recordConsent?.()]);
    if (this.dead) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
    if (this.dead) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    if (!this.context.audioWorklet) throw new Error("Este navegador no admite la captura de audio requerida.");
    await this.context.audioWorklet.addModule("/mic-pcm.js");
    if (this.dead) return;
    const worklet = new AudioWorkletNode(this.context, "microphone-pcm", {
      channelCount: 1,
      channelCountMode: "explicit",
    });
    this.worklet = worklet;
    worklet.onprocessorerror = () => this.interrupt("Se interrumpió el micrófono. Reanuda para continuar.");
    const interrupted = () => {
      if (!this.closing) this.interrupt("El micrófono dejó de estar disponible. Reanuda para continuar.");
    };
    for (const track of stream.getAudioTracks()) {
      track.onended = interrupted;
      track.onmute = interrupted;
    }
    this.context.onstatechange = () => {
      if (this.context.state !== "running") interrupted();
    };
  }

  start() {
    if (this.dead || !this.worklet || !this.stream) return;
    this.worklet.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => this.enqueue(data);
    this.context.createMediaStreamSource(this.stream).connect(this.worklet);
    // La salida del procesador permanece en silencio.
    this.worklet.connect(this.context.destination);
  }

  private enqueue(chunk: ArrayBuffer) {
    if (this.dead || !chunk.byteLength) return;
    if (this.queued >= 8) {
      this.interrupt("La conexión no alcanzó a enviar el audio. Reanuda la escucha.");
      return;
    }
    this.queued++;
    const sequence = this.sequence++;
    this.queue = this.queue.then(async () => {
      if (this.dead) return;
      const timer = window.setTimeout(() => this.interrupt("Se perdió la conexión de audio. Reanuda la escucha."), 6500);
      try {
        await api.audio(this.interviewId, this.id, sequence, chunk, this.abort.signal);
      } catch (e) {
        this.interrupt(e instanceof Error && e.message ? e.message : "Se interrumpió el audio.");
      } finally {
        window.clearTimeout(timer);
      }
    }).finally(() => { this.queued--; });
  }

  async finish() {
    if (this.dead) return;
    this.closing = true;
    this.stream?.getTracks().forEach((track) => track.stop());
    const node = this.worklet;
    if (node) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 150);
        node.port.onmessage = ({ data }: MessageEvent<ArrayBuffer | null>) => {
          if (data) this.enqueue(data);
          else {
            window.clearTimeout(timer);
            resolve();
          }
        };
        node.port.postMessage("flush");
      });
    }
    await this.queue;
    this.stop();
  }

  stop() {
    if (this.dead) return;
    this.dead = true;
    this.abort.abort();
    this.worklet?.disconnect();
    this.worklet?.port.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context.close().catch(() => undefined);
  }

  private interrupt(message: string) {
    if (this.dead) return;
    this.stop();
    if (!this.closing) this.onInterrupt(message);
  }
}
