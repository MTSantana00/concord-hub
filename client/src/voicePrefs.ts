import { useSyncExternalStore } from "react";

export interface VoicePrefs {
  /** Dispositivos escolhidos ("" = o padrão do sistema). */
  micId: string;
  camId: string;
  speakerId: string;
  /** Falar só segurando uma tecla. */
  pushToTalk: boolean;
  /** `KeyboardEvent.code` da tecla de falar. */
  pttKey: string;
  /** Supressão de ruído do microfone (teclado, ventilador, fundo). Ligada por padrão. */
  noiseSuppression: boolean;
  /** Cancelamento de eco (evita que o som da caixa volte pelo microfone). Ligado por padrão. */
  echoCancellation: boolean;
  /** Volume de cada pessoa (0 a 100), por id de usuário. Ausente = 100. */
  volumes: Record<string, number>;
  /** Volume da transmissão de tela de cada pessoa (0 a 100), à parte da voz. Ausente = 100. */
  streamVolumes: Record<string, number>;
  /** Sensibilidade do portão de voz: automática (aprende o ruído e a voz) ou manual. */
  gateAuto: boolean;
  /** Limite do portão no modo manual, em dB (-70 muito sensível, -20 só voz alta). */
  gateDb: number;
}

const KEY = "concord.voice";
const DEFAULT: VoicePrefs = { micId: "", camId: "", speakerId: "", pushToTalk: false, pttKey: "KeyV", noiseSuppression: true, echoCancellation: true, volumes: {}, streamVolumes: {}, gateAuto: true, gateDb: -45 };

function load(): VoicePrefs {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<VoicePrefs> | null;
    const clean = (raw: unknown) => {
      const out: Record<string, number> = {};
      for (const [id, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) if (typeof v === "number" && v >= 0 && v <= 100) out[id] = Math.round(v);
      return out;
    };
    const volumes = clean(s?.volumes);
    const streamVolumes = clean(s?.streamVolumes);
    return {
      micId: typeof s?.micId === "string" ? s.micId : "",
      camId: typeof s?.camId === "string" ? s.camId : "",
      speakerId: typeof s?.speakerId === "string" ? s.speakerId : "",
      pushToTalk: s?.pushToTalk === true,
      pttKey: typeof s?.pttKey === "string" && s.pttKey !== "" ? s.pttKey : DEFAULT.pttKey,
      noiseSuppression: s?.noiseSuppression !== false,
      echoCancellation: s?.echoCancellation !== false,
      volumes,
      streamVolumes,
      gateAuto: s?.gateAuto !== false,
      gateDb: typeof s?.gateDb === "number" && s.gateDb >= -70 && s.gateDb <= -20 ? Math.round(s.gateDb) : DEFAULT.gateDb,
    };
  } catch {
    return DEFAULT;
  }
}

let current = load();
const listeners = new Set<() => void>();

export const getVoicePrefs = () => current;

/** Avisa quando as preferências mudam (usado pelo filtro de ruído para ajustar o portão ao vivo). */
export function subscribeVoicePrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function updateVoicePrefs(patch: Partial<VoicePrefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // sem armazenamento: vale até recarregar
  }
  for (const l of listeners) l();
}

/** Volta ao que está guardado (para os testes, que limpam o localStorage). */
export function resetVoicePrefs() {
  current = load();
  for (const l of listeners) l();
}

export function useVoicePrefs(): VoicePrefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/** Nome legível de uma tecla para mostrar na tela. */
export const keyLabel = (code: string) => code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "Seta ") || code;
