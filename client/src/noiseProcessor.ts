// Supressão de ruído "de verdade" para o microfone: GTCRN (rede neural, roda no próprio aparelho, grátis) e um portão de ruído.
// O filtro do navegador é fraco com teclado, ventilador e conversa ao fundo; este tira o ruído antes de a voz sair para a sala.
// Medido com fala sintética + cliques de teclado: o RNNoise cortava só 6 a 12 dB dos cliques; o GTCRN corta ~22 dB durante a fala
// e quase tudo no silêncio. Depois dele vem o portão de voz (automático ou manual), que corta o que não dura como fala.
// Roda só no aparelho de quem fala: nenhum áudio vai para fora do Concord por causa dele.
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { GtcrnWorkletNode, loadGtcrn, loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import gtcrnWasmPath from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?url";
import gtcrnWorkletPath from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import { emitGateLevel } from "./gateLevel";
import { getVoicePrefs, subscribeVoicePrefs } from "./voicePrefs";

/** O filtro trabalha a 48 kHz; por isso este processador usa o próprio contexto de áudio, e não o do LiveKit. */
const SAMPLE_RATE = 48_000;
/** Portão de voz próprio (public/voice-gate-worklet.js): só abre para o que dura como fala, então clique de teclado ou de mouse no silêncio não passa. */
const GATE_WORKLET = "/voice-gate-worklet.js";
/** Supressor de cliques (public/click-duck-worklet.js): abafa por ~20 ms as subidas bruscas de volume típicas de tecla e de mouse. */
const DUCK_WORKLET = "/click-duck-worklet.js";
/**
 * Medido com teclado mecânico, mouse e ventilador ao fundo (fala sintética): só o GTCRN + portão antigo reduzia o barulho em 12 dB durante a fala;
 * GTCRN + RNNoise + supressor de cliques + portão que exige 70 ms de fala reduz 24 dB (29 dB nos intervalos), com a voz a -0,9 dB.
 * O preço é atraso: ~150 ms no total (GTCRN 32 + RNNoise 10 + supressor 6 + portão 100).
 */
const GATE_OPEN_AFTER_MS = 70;
const GATE_LOOKAHEAD_MS = 100;
/** Atraso do GTCRN (medido: ~32 ms): o som original que misturamos de volta precisa esperar o mesmo tempo, senão a voz fica "oca". */
const DENOISE_LATENCY_S = 0.032 + 0.01; // GTCRN (32 ms) + RNNoise (10 ms)
/** O GTCRN trabalha a 16 kHz e corta tudo acima de 8 kHz (-16 dB medido): a voz fica de telefone, abafada. Devolvemos esse brilho do som original (medido com fala: de -16 dB para -2 dB, e o nível da voz não muda). */
const AIR_HZ = 7000;

export type NoiseProcessor = TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>;

export function createNoiseProcessor(): NoiseProcessor {
  let ctx: AudioContext | null = null;
  let nodes: AudioNode[] = [];
  let wasm: ArrayBuffer | null = null;
  let rnWasm: ArrayBuffer | null = null;
  let unsubscribe: (() => void) | null = null;

  async function teardown() {
    unsubscribe?.();
    unsubscribe = null;
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        // já solto
      }
    }
    nodes = [];
    const old = ctx;
    ctx = null;
    processor.processedTrack = undefined;
    if (old && old.state !== "closed") await old.close().catch(() => {});
  }

  async function build(track: MediaStreamTrack) {
    if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") throw new Error("Este navegador não tem AudioWorklet.");
    const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    ctx = context;
    try {
      wasm ??= await loadGtcrn({ url: gtcrnWasmPath });
      rnWasm ??= await loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseSimdWasmPath });
      await context.audioWorklet.addModule(gtcrnWorkletPath);
      await context.audioWorklet.addModule(rnnoiseWorkletPath);
      await context.audioWorklet.addModule(DUCK_WORKLET);
      await context.audioWorklet.addModule(GATE_WORKLET);
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const denoise = new GtcrnWorkletNode(context, { wasmBinary: wasm, maxChannels: 1 });
      const prefs = getVoicePrefs();
      const gate = new AudioWorkletNode(context, "voice-gate", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { auto: prefs.gateAuto, thresholdDb: prefs.gateDb, openAfterMs: GATE_OPEN_AFTER_MS, lookaheadMs: GATE_LOOKAHEAD_MS } });
      gate.port.onmessage = (e) => emitGateLevel(e.data);
      // mexer na sensibilidade vale na hora, sem reiniciar o microfone
      unsubscribe = subscribeVoicePrefs(() => {
        const p = getVoicePrefs();
        gate.port.postMessage({ auto: p.gateAuto, thresholdDb: p.gateDb });
      });
      const rn = new RnnoiseWorkletNode(context, { wasmBinary: rnWasm, maxChannels: 1 });
      const duck = new AudioWorkletNode(context, "click-duck", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const mixer = context.createGain();
      const out = context.createMediaStreamDestination();
      // som limpo (GTCRN) + o "ar" acima de 8 kHz do original, atrasado o mesmo tanto (o GTCRN corta essa faixa)
      const air = context.createGain();
      air.gain.value = 0.5;
      const delay = context.createDelay(0.2);
      delay.delayTime.value = DENOISE_LATENCY_S;
      const hp1 = context.createBiquadFilter();
      const hp2 = context.createBiquadFilter();
      for (const hp of [hp1, hp2]) {
        hp.type = "highpass";
        hp.frequency.value = AIR_HZ;
        hp.Q.value = 0.707;
      }
      source.connect(denoise);
      denoise.connect(rn);
      rn.connect(mixer);
      source.connect(delay);
      delay.connect(hp1);
      hp1.connect(hp2);
      hp2.connect(air);
      air.connect(mixer);
      mixer.connect(duck);
      duck.connect(gate);
      gate.connect(out);
      nodes = [source, denoise, rn, mixer, duck, air, delay, hp1, hp2, gate, out];
      if (context.state === "suspended") await context.resume().catch(() => {});
      processor.processedTrack = out.stream.getAudioTracks()[0];
    } catch (err) {
      await teardown();
      throw err;
    }
  }

  const processor: NoiseProcessor & { processedTrack?: MediaStreamTrack } = {
    name: "concord-noise-suppression",
    async init(opts) {
      await build(opts.track);
    },
    async restart(opts) {
      await teardown();
      await build(opts.track);
    },
    async destroy() {
      await teardown();
    },
  };
  return processor;
}
