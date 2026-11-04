import { useSyncExternalStore } from "react";

export interface NotifyPrefs {
  /** Sons de mensagem e de menção. */
  sounds: boolean;
  /** Avisos sonoros da chamada: mutar, ensurdecer, câmera, tela, entrar e sair. */
  callSounds: boolean;
  /** 0 a 100. */
  volume: number;
  /** Notificações do navegador quando a janela está em segundo plano. */
  desktop: boolean;
}

const KEY = "concord.notify";
// No app de computador não há o que o navegador pergunta: os avisos já nascem ligados
const inDesktopApp = typeof window !== "undefined" && "concordDesktop" in window;
const DEFAULT: NotifyPrefs = { sounds: true, callSounds: true, volume: 60, desktop: inDesktopApp };

function load(): NotifyPrefs {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<NotifyPrefs> | null;
    return {
      sounds: typeof s?.sounds === "boolean" ? s.sounds : DEFAULT.sounds,
      callSounds: typeof s?.callSounds === "boolean" ? s.callSounds : DEFAULT.callSounds,
      volume: typeof s?.volume === "number" && s.volume >= 0 && s.volume <= 100 ? Math.round(s.volume) : DEFAULT.volume,
      desktop: typeof s?.desktop === "boolean" ? s.desktop : DEFAULT.desktop,
    };
  } catch {
    return DEFAULT;
  }
}

let current = load();
const listeners = new Set<() => void>();

export const getNotifyPrefs = () => current;

export function updateNotifyPrefs(patch: Partial<NotifyPrefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // sem armazenamento: vale até recarregar
  }
  for (const l of listeners) l();
}

/** Recarrega do armazenamento (usado pelos testes, que limpam o localStorage entre um teste e outro). */
export function resetNotifyPrefs() {
  current = load();
  for (const l of listeners) l();
}

export function useNotifyPrefs(): NotifyPrefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
