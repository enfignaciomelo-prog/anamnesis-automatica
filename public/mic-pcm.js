/* PCM mono de 16 bits, little endian, sin salida audible. */
class MicrophonePcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = Math.round(sampleRate / 4);
    this.buffer = new DataView(new ArrayBuffer(this.frames * 2));
    this.count = 0;
    this.active = true;
    this.port.onmessage = () => {
      this.active = false;
      this.flush();
      this.port.postMessage(null);
    };
  }

  flush() {
    if (!this.count) return;
    const out = this.buffer.buffer.slice(0, this.count * 2);
    this.port.postMessage(out, [out]);
    this.count = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!this.active || !input) return true;
    for (const sample of input) {
      const value = Math.max(-1, Math.min(1, sample));
      this.buffer.setInt16(this.count++ * 2, value * (value < 0 ? 32768 : 32767), true);
      if (this.count === this.frames) this.flush();
    }
    return true;
  }
}

registerProcessor("microphone-pcm", MicrophonePcm);
