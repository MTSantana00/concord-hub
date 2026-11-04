import type { ScreenShareCaptureOptions, TrackPublishOptions } from "livekit-client";

/** Meta pedida para a tela compartilhada. O navegador, o monitor e a internet decidem o que sai de verdade. */
export const TARGET = { width: 1920, height: 1080, fps: 120 } as const;
/** A partir daqui o medidor considera que a meta foi cumprida (pequenas oscilações de fps são normais). */
export const MIN_OK_FPS = 100;

/** O que pedimos ao navegador ao capturar a tela. */
export const screenCaptureOptions: ScreenShareCaptureOptions = {
  resolution: { width: TARGET.width, height: TARGET.height, frameRate: TARGET.fps },
  // "motion": o navegador prefere manter a fluidez (jogos, vídeo) a borrar a imagem em movimento
  contentHint: "motion",
  audio: false,
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include",
};

/** Como enviamos: uma camada só (sem versões menores), teto de taxa de bits alto e prioridade para a resolução. */
export const screenPublishOptions: TrackPublishOptions = {
  videoCodec: "vp9", // o LiveKit manda um vídeo VP8 de reserva para quem não decodifica VP9
  simulcast: false,
  screenShareEncoding: { maxBitrate: 25_000_000, maxFramerate: TARGET.fps },
  degradationPreference: "maintain-resolution",
};

export interface Measure {
  width: number;
  height: number;
  /** Quadros por segundo (inteiro). */
  fps: number;
  /** Motivo que o navegador deu para reduzir a qualidade ("cpu", "bandwidth"), se houver. */
  limit?: string;
}

export interface Assessment {
  ok: boolean;
  /** Texto para o usuário; vazio quando a meta foi cumprida. */
  note: string;
}

/** Compara o que foi medido com a meta de 1080p / 120 fps e explica o que ficou abaixo. */
export function assess(m: Measure): Assessment {
  const lowRes = m.height < TARGET.height;
  const lowFps = m.fps < MIN_OK_FPS;
  if (!lowRes && !lowFps) return { ok: true, note: "" };

  const parts: string[] = [];
  if (lowRes) parts.push(`resolução ${m.width}×${m.height} (meta ${TARGET.width}×${TARGET.height})`);
  if (lowFps) parts.push(`${m.fps} fps (meta ${TARGET.fps})`);

  const causes: string[] = [];
  if (m.limit === "cpu") causes.push("o computador está no limite do processador");
  else if (m.limit === "bandwidth") causes.push("a internet não aguenta mais");
  if (lowFps) causes.push("monitor de 60 Hz ou navegador que limita os quadros");
  return { ok: false, note: `Abaixo da meta: ${parts.join(" e ")}. Causas comuns: ${causes.join("; ") || "limite do equipamento ou da rede"}.` };
}

/** fps estimado a partir do contador de quadros entre duas leituras (leituras em milissegundos). */
export function fpsBetween(prev: { frames: number; at: number } | undefined, now: { frames: number; at: number }): number {
  if (!prev || now.at <= prev.at || now.frames < prev.frames) return 0;
  return Math.round(((now.frames - prev.frames) * 1000) / (now.at - prev.at));
}

export function describeMeasure(m: Measure): string {
  return `${m.width}×${m.height} · ${m.fps} fps`;
}
