// Supressor de cliques (AudioWorklet). Roda depois do filtro neural e antes do portão de voz.
// Clique de teclado/mouse é uma subida brusca de volume (menos de 1 ms) seguida de queda rápida; a fala sobe devagar (dezenas de ms).
// Quando o volume rápido passa muito do volume lento, o som é abafado por alguns milissegundos. O áudio sai 6 ms atrasado
// para o abafamento chegar antes do clique.
const LOOKAHEAD_MS = 6;
const HOLD_MS = 22;
const RATIO = 4; // 12 dB acima do volume lento
const ABS_MIN = 0.004; // ignora o que está abaixo de -48 dBFS
const DUCK_GAIN = 0.15; // -16 dB

class ClickDuck extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.ratio = typeof o.ratio === "number" ? o.ratio : RATIO;
    this.duck = typeof o.duckGain === "number" ? o.duckGain : DUCK_GAIN;
    this.delay = Math.round((LOOKAHEAD_MS / 1000) * sampleRate);
    this.size = this.delay + 256;
    this.ring = new Float32Array(this.size);
    this.write = 0;
    this.ef = 0;
    this.es = 0;
    this.hold = 0;
    this.gain = 1;
    this.holdSamples = Math.round((HOLD_MS / 1000) * sampleRate);
    const k = (ms) => 1 - Math.exp(-1 / ((ms / 1000) * sampleRate));
    this.aF = k(0.4);
    this.rF = k(4);
    this.aS = k(25);
    this.rS = k(120);
    this.gDown = k(0.8);
    this.gUp = k(6);
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const a = x < 0 ? -x : x;
      this.ef += (a - this.ef) * (a > this.ef ? this.aF : this.rF);
      this.es += (a - this.es) * (a > this.es ? this.aS : this.rS);
      if (this.ef > this.ratio * this.es && this.ef > ABS_MIN) this.hold = this.holdSamples;
      const target = this.hold > 0 ? this.duck : 1;
      if (this.hold > 0) this.hold--;
      this.gain += (target - this.gain) * (target < this.gain ? this.gDown : this.gUp);
      this.ring[this.write] = x;
      const read = (this.write - this.delay + this.size) % this.size;
      output[i] = this.ring[read] * this.gain;
      this.write = (this.write + 1) % this.size;
    }
    return true;
  }
}
registerProcessor("click-duck", ClickDuck);
