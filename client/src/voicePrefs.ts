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
  /** Volume de cada pessoa (0 a 100), por id de usuário. Ausente = 100. */
  volumes: Record<string, number>;
}

const KEY = "concord.voice";
const DEFAULT: VoicePrefs = { micId: "", camId: "", speakerId: "", pushToTalk: false, pttKey: "KeyV", volumes: {} };

function load(): VoicePrefs {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<VoicePrefs> | null;
    const volumes: Record<string, number> = {};
    for (const [id, v] of Object.entries(s?.volumes ?? {})) if (typeof v === "number" && v >= 0 && v <= 100) volumes[id] = Math.round(v);
    return {
      micId: typeof s?.micId === "string" ? s.micId : "",
      camId: typeof s?.camId === "string" ? s.camId : "",
      speakerId: typeof s?.speakerId === "string" ? s.speakerId : "",
      pushToTalk: s?.pushToTalk === true,
      pttKey: typeof s?.pttKey === "string" && s.pttKey !== "" ? s.pttKey : DEFAULT.pttKey,
      volumes,
    };
  } catch {
    return DEFAULT;
  }
}

let current = load();
const listeners = new Set<() => void>();

export const getVoicePrefs = () => current;

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
