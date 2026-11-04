import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_LEAVE_MS, IDLE_WARN_MS, useIdleLeave, type IdleInput } from "./idleLeave";

const ativo: Omit<IdleInput, "onLeave"> = { enabled: true, alone: false, meMuted: false, someoneSpeaking: true, anyVideo: false };
const minutos = (n: number) => n * 60 * 1000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function montar(inicial: Partial<IdleInput> = {}) {
  const onLeave = vi.fn();
  const hook = renderHook((p: Partial<IdleInput>) => useIdleLeave({ ...ativo, ...p, onLeave }), { initialProps: inicial });
  const passa = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  return { ...hook, onLeave, passa };
}

describe("sair sozinho da sala parada", () => {
  it("sozinho na sala: avisa 1 minuto antes (com contagem) e sai aos 10 minutos, uma vez só", () => {
    const { result, onLeave, passa } = montar({ alone: true });
    passa(IDLE_LEAVE_MS - IDLE_WARN_MS - 2000);
    expect(result.current.secondsLeft).toBeNull();
    passa(3000);
    expect(result.current.secondsLeft).toBeGreaterThan(55);
    expect(onLeave).not.toHaveBeenCalled();
    passa(IDLE_WARN_MS); // chegou aos 10 minutos
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(result.current.secondsLeft).toBeNull();
  });

  it("'continuar na sala' zera a contagem e o aviso some", () => {
    const { result, onLeave, passa } = montar({ alone: true });
    passa(minutos(9) + 5000);
    expect(result.current.secondsLeft).not.toBeNull();
    act(() => result.current.keepGoing());
    expect(result.current.secondsLeft).toBeNull();
    passa(minutos(9));
    expect(onLeave).not.toHaveBeenCalled();
    passa(minutos(1) + 2000);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("conversa normal (alguém falando, eu com o microfone aberto): nunca sai", () => {
    const { result, onLeave, passa } = montar();
    passa(minutos(40));
    expect(onLeave).not.toHaveBeenCalled();
    expect(result.current.secondsLeft).toBeNull();
  });

  it("microfone desligado e nada para assistir: sai mesmo com os outros falando (não gasta à toa)", () => {
    const { onLeave, passa } = montar({ meMuted: true, someoneSpeaking: true });
    passa(IDLE_LEAVE_MS + 2000);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("mutado mas assistindo uma tela ou câmera: fica (quem assiste não está parado)", () => {
    const { onLeave, passa } = montar({ meMuted: true, anyVideo: true });
    passa(minutos(30));
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("sala toda em silêncio, sem tela nem câmera: sai; com tela compartilhada, fica", () => {
    const calada = montar({ someoneSpeaking: false });
    calada.passa(IDLE_LEAVE_MS + 2000);
    expect(calada.onLeave).toHaveBeenCalledTimes(1);

    const comTela = montar({ someoneSpeaking: false, anyVideo: true });
    comTela.passa(minutos(30));
    expect(comTela.onLeave).not.toHaveBeenCalled();
  });

  it("qualquer atividade zera a contagem: alguém voltou a falar aos 9 minutos", () => {
    const { rerender, result, onLeave, passa } = montar({ someoneSpeaking: false });
    passa(minutos(9) + 5000);
    expect(result.current.secondsLeft).not.toBeNull();
    rerender({ someoneSpeaking: true }); // voltaram a conversar
    passa(2000);
    expect(result.current.secondsLeft).toBeNull();
    rerender({ someoneSpeaking: false });
    passa(minutos(9));
    expect(onLeave).not.toHaveBeenCalled(); // recomeçou do zero
    passa(minutos(1) + 3000);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("desligado (fora de sala de voz): nada acontece", () => {
    const { result, onLeave, passa } = montar({ enabled: false, alone: true });
    passa(minutos(30));
    expect(onLeave).not.toHaveBeenCalled();
    expect(result.current.secondsLeft).toBeNull();
  });
});
