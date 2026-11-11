// Portão de voz do Concord (AudioWorklet). Roda no aparelho de quem fala, depois do filtro de ruído neural.
// Ideia: só deixa passar o que dura como fala. Um clique de teclado ou de mouse dura 10 a 20 ms; uma sílaba, 60 ms ou mais.
// O portão "olha à frente" 50 ms: só abre quando o som passa do limite por 30 ms seguidos, e o áudio sai atrasado esses 50 ms,
// então o começo da fala não é cortado, mas o clique isolado nunca abre o portão.
// Dois modos: automático (aprende o ruído de fundo e o volume da voz da pessoa; serve para microfones muito sensíveis,
// como os condensadores) e manual (a pessoa escolhe o limite em dB).
const LOOKAHEAD_MS = 50;
const OPEN_AFTER_MS = 30;
const HOLD_MS = 180;
const ATTACK_MS = 6;
const RELEASE_MS = 45;
const HYSTERESIS_DB = 5;

class VoiceGate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.auto = o.auto !== false;
    this.manualDb = typeof o.thresholdDb === "number" ? o.thresholdDb : -45;
    this.delay = Math.round((LOOKAHEAD_MS / 1000) * sampleRate);
    this.size = this.delay + 256;
    this.ring = new Float32Array(this.size);
    this.write = 0;
    this.open = false;
    this.aboveMs = 0;
    this.belowMs = 0;
    this.gain = 0;
    this.floor = -60; // ruído de fundo estimado (dB)
    this.speech = -30; // volume da voz estimado (dB)
    this.reportMs = 0;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (typeof m.auto === "boolean") this.auto = m.auto;
      if (typeof m.thresholdDb === "number") this.manualDb = m.thresholdDb;
    };
  }

  threshold() {
    if (!this.auto) return this.manualDb;
    // acima do ruído de fundo e perto do que a voz costuma atingir; nunca absurdamente alto nem baixo
    return Math.min(-26, Math.max(-64, Math.max(this.floor + 12, this.speech - 30)));
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }
    const n = input.length;
    const blockMs = (n / sampleRate) * 1000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += input[i] * input[i];
    const db = 20 * Math.log10(Math.sqrt(sum / n) + 1e-9);

    // ruído de fundo: cai rápido, sobe devagar (~6 s)
    this.floor = db < this.floor ? this.floor + (db - this.floor) * 0.2 : this.floor + (db - this.floor) * 0.00045;
    this.floor = Math.max(-80, Math.min(-30, this.floor));

    const thr = this.threshold();
    const closeThr = thr - HYSTERESIS_DB;
    if (!this.open) {
      this.aboveMs = db > thr ? this.aboveMs + blockMs : 0;
      if (this.aboveMs >= OPEN_AFTER_MS) {
        this.open = true;
        this.belowMs = 0;
      }
    } else {
      this.belowMs = db < closeThr ? this.belowMs + blockMs : 0;
      if (this.belowMs >= HOLD_MS) {
        this.open = false;
        this.aboveMs = 0;
      }
      if (db > this.speech) this.speech = db;
    }
    this.speech = Math.max(-50, this.speech - 0.012); // esquece devagar (~4,5 dB/s)

    const target = this.open ? 1 : 0;
    const coef = 1 - Math.exp(-1 / (((target > this.gain ? ATTACK_MS : RELEASE_MS) / 1000) * sampleRate));
    for (let i = 0; i < n; i++) {
      this.ring[this.write] = input[i];
      const read = (this.write - this.delay + this.size) % this.size;
      this.gain += (target - this.gain) * coef;
      output[i] = this.ring[read] * this.gain;
      this.write = (this.write + 1) % this.size;
    }

    this.reportMs += blockMs;
    if (this.reportMs >= 60) {
      this.reportMs = 0;
      this.port.postMessage({ db, threshold: thr, open: this.open });
    }
    return true;
  }
}
registerProcessor("voice-gate", VoiceGate);
