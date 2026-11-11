// Supressão de ruído "de verdade" para o microfone: GTCRN (rede neural, roda no próprio aparelho, grátis) e um portão de ruído.
// O filtro do navegador é fraco com teclado, ventilador e conversa ao fundo; este tira o ruído antes de a voz sair para a sala.
// Medido com fala sintética + cliques de teclado: o RNNoise cortava só 6 a 12 dB dos cliques; o GTCRN corta ~22 dB durante a fala
// e quase tudo no silêncio. Depois dele vem o portão de voz (automático ou manual), que corta o que não dura como fala.
// Roda só no aparelho de quem fala: nenhum áudio vai para fora do Concord por causa dele.
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { GtcrnWorkletNode, loadGtcrn } from "@sapphi-red/web-noise-suppressor";
import gtcrnWasmPath from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?url";
import gtcrnWorkletPath from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url";
import { emitGateLevel } from "./gateLevel";
import { getVoicePrefs, subscribeVoicePrefs } from "./voicePrefs";

/** O filtro trabalha a 48 kHz; por isso este processador usa o próprio contexto de áudio, e não o do LiveKit. */
const SAMPLE_RATE = 48_000;
/** Portão de voz próprio (public/voice-gate-worklet.js): só abre para o que dura como fala, então clique de teclado ou de mouse no silêncio não passa. */
const GATE_WORKLET = "/voice-gate-worklet.js";

export type NoiseProcessor = TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>;

export function createNoiseProcessor(): NoiseProcessor {
  let ctx: AudioContext | null = null;
  let nodes: AudioNode[] = [];
  let wasm: ArrayBuffer | null = null;
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
      await context.audioWorklet.addModule(gtcrnWorkletPath);
      await context.audioWorklet.addModule(GATE_WORKLET);
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const denoise = new GtcrnWorkletNode(context, { wasmBinary: wasm, maxChannels: 1 });
      const prefs = getVoicePrefs();
      const gate = new AudioWorkletNode(context, "voice-gate", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { auto: prefs.gateAuto, thresholdDb: prefs.gateDb } });
      gate.port.onmessage = (e) => emitGateLevel(e.data);
      // mexer na sensibilidade vale na hora, sem reiniciar o microfone
      unsubscribe = subscribeVoicePrefs(() => {
        const p = getVoicePrefs();
        gate.port.postMessage({ auto: p.gateAuto, thresholdDb: p.gateDb });
      });
      const out = context.createMediaStreamDestination();
      source.connect(denoise);
      denoise.connect(gate);
      gate.connect(out);
      nodes = [source, denoise, gate, out];
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
