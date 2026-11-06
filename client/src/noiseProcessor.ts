// Supressão de ruído "de verdade" para o microfone: GTCRN (rede neural, roda no próprio aparelho, grátis) e um portão de ruído.
// O filtro do navegador é fraco com teclado, ventilador e conversa ao fundo; este tira o ruído antes de a voz sair para a sala.
// Medido com fala sintética + cliques de teclado: o RNNoise cortava só 6 a 12 dB dos cliques; o GTCRN corta ~22 dB durante a fala
// (e ~31 dB com o portão) e quase tudo no silêncio, sem perder nível de voz.
// Roda só no aparelho de quem fala: nenhum áudio vai para fora do Concord por causa dele.
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { GtcrnWorkletNode, loadGtcrn, NoiseGateWorkletNode } from "@sapphi-red/web-noise-suppressor";
import noiseGateWorkletPath from "@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url";
import gtcrnWasmPath from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?url";
import gtcrnWorkletPath from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url";

/** O filtro trabalha a 48 kHz; por isso este processador usa o próprio contexto de áudio, e não o do LiveKit. */
const SAMPLE_RATE = 48_000;
/** Portão: abre com a voz e fecha no silêncio, sem ninguém precisar apertar tecla. Valores em dB. */
// Medido: portão rápido (-48/-54 dB, 120 ms) tira ~41 dB dos cliques durante a fala; o antigo (-55/-62, 300 ms) tirava ~32 dB.
const GATE = { openThreshold: -48, closeThreshold: -54, holdMs: 120, maxChannels: 1 };

export type NoiseProcessor = TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>;

export function createNoiseProcessor(): NoiseProcessor {
  let ctx: AudioContext | null = null;
  let nodes: AudioNode[] = [];
  let wasm: ArrayBuffer | null = null;

  async function teardown() {
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
      await context.audioWorklet.addModule(noiseGateWorkletPath);
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const denoise = new GtcrnWorkletNode(context, { wasmBinary: wasm, maxChannels: 1 });
      const gate = new NoiseGateWorkletNode(context, GATE);
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
