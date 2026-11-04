import { useCallback, useEffect, useRef, useState } from "react";

/** Depois de quanto tempo parada a pessoa sai sozinha da sala (cada minuto conectado gasta o plano gratuito de voz). */
export const IDLE_LEAVE_MS = 10 * 60 * 1000;
/** Quanto tempo antes de sair o aviso aparece, com o botão de continuar. */
export const IDLE_WARN_MS = 60 * 1000;

export interface IdleInput {
  /** Só vale dentro de uma sala de voz já conectada. */
  enabled: boolean;
  /** Ninguém mais na sala. */
  alone: boolean;
  /** Meu microfone está desligado. */
  meMuted: boolean;
  /** Alguém está falando agora. */
  someoneSpeaking: boolean;
  /** Alguém compartilha tela ou câmera (quem está assistindo não é "parado"). */
  anyVideo: boolean;
  /** Sair da sala. */
  onLeave: () => void;
}

/**
 * Sai da sala depois de 10 minutos "parados": sozinho na sala, ou com o microfone desligado sem nada para assistir,
 * ou sala toda em silêncio sem tela nem câmera. Um minuto antes avisa, e "continuar" zera a contagem.
 * Devolve os segundos que faltam (null = sem aviso) e a função de continuar.
 */
export function useIdleLeave(input: IdleInput) {
  const { enabled, alone, meMuted, someoneSpeaking, anyVideo, onLeave } = input;
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const lastActive = useRef(Date.now());
  const state = useRef({ alone, meMuted, someoneSpeaking, anyVideo });
  state.current = { alone, meMuted, someoneSpeaking, anyVideo };
  const fired = useRef(false); // já pediu para sair: não repete enquanto a saída não se confirma
  const leave = useRef(onLeave);
  leave.current = onLeave;

  const keepGoing = useCallback(() => {
    lastActive.current = Date.now();
    setSecondsLeft(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSecondsLeft(null);
      return;
    }
    lastActive.current = Date.now();
    fired.current = false;
    const timer = setInterval(() => {
      if (fired.current) return;
      const s = state.current;
      const idle = s.alone || (s.meMuted && !s.anyVideo) || (!s.someoneSpeaking && !s.anyVideo);
      const now = Date.now();
      if (!idle) {
        lastActive.current = now;
        setSecondsLeft(null);
        return;
      }
      const waited = now - lastActive.current;
      if (waited >= IDLE_LEAVE_MS) {
        setSecondsLeft(null);
        fired.current = true;
        leave.current();
      } else if (waited >= IDLE_LEAVE_MS - IDLE_WARN_MS) {
        setSecondsLeft(Math.max(1, Math.ceil((IDLE_LEAVE_MS - waited) / 1000)));
      } else {
        setSecondsLeft(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [enabled]);

  return { secondsLeft, keepGoing };
}
