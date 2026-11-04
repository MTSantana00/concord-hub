import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateNotifyPrefs } from "./notifyPrefs";
import { installAudioUnlock, playCallSound, playSound, resetSoundContext } from "./sounds";

/** AudioContext falso: conta quantas notas (osciladores) foram tocadas e em que frequências. */
function fakeAudio() {
  const freqs: number[] = [];
  class FakeContext {
    state = "running";
    currentTime = 0;
    destination = {};
    resume() {}
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
    createOscillator() {
      const osc = { type: "", frequency: { value: 0 }, connect() {}, start() { freqs.push(osc.frequency.value); }, stop() {} };
      return osc;
    }
  }
  vi.stubGlobal("AudioContext", FakeContext);
  Object.assign(window, { AudioContext: FakeContext });
  return freqs;
}

beforeEach(() => {
  resetSoundContext();
  localStorage.clear();
  updateNotifyPrefs({ sounds: true, callSounds: true, volume: 60 });
});
afterEach(() => vi.unstubAllGlobals());

describe("avisos sonoros", () => {
  it("cada ação da chamada tem o seu desenho de notas: ligar sobe, desligar desce", () => {
    const freqs = fakeAudio();
    const tocar = (kind: Parameters<typeof playCallSound>[0]) => {
      freqs.length = 0;
      playCallSound(kind);
      return [...freqs];
    };
    const up = (n: number[]) => n.every((f, i) => i === 0 || f > n[i - 1]);
    const down = (n: number[]) => n.every((f, i) => i === 0 || f < n[i - 1]);
    for (const k of ["unmute", "undeafen", "camera-on", "screen-on", "join"] as const) expect(up(tocar(k)), k).toBe(true);
    for (const k of ["mute", "deafen", "camera-off", "screen-off", "leave"] as const) expect(down(tocar(k)), k).toBe(true);
    expect(tocar("deafen")).toHaveLength(3);
    expect(tocar("mute")).toHaveLength(2);
  });

  it("some se a pessoa desligou os avisos da chamada; as mensagens continuam tocando", () => {
    const freqs = fakeAudio();
    updateNotifyPrefs({ callSounds: false });
    playCallSound("mute");
    expect(freqs).toHaveLength(0);
    playSound("message", 60);
    expect(freqs).toEqual([660]);
  });
});

describe("liberar o áudio no primeiro toque", () => {
  it("acorda o áudio no primeiro toque (antes de qualquer som) e depois sai de cena", () => {
    const calls = { resume: 0, silentTicks: 0 };
    class SuspendedContext {
      state = "suspended";
      currentTime = 0;
      destination = {};
      resume() {
        calls.resume++;
        this.state = "running";
        return Promise.resolve();
      }
      createBuffer() {
        return {};
      }
      createBufferSource() {
        return { buffer: null, connect() {}, start() { calls.silentTicks++; } };
      }
      createGain() {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
      }
      createOscillator() {
        return { type: "", frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
      }
    }
    vi.stubGlobal("AudioContext", SuspendedContext);
    Object.assign(window, { AudioContext: SuspendedContext });
    const session = { type: "auto" };
    vi.stubGlobal("navigator", { ...navigator, audioSession: session });

    installAudioUnlock();
    window.dispatchEvent(new Event("pointerdown"));
    expect(calls).toEqual({ resume: 1, silentTicks: 1 });
    expect(session.type).toBe("playback"); // toca mesmo com o iPhone no silencioso

    window.dispatchEvent(new Event("click")); // já destravado: não faz mais nada
    expect(calls).toEqual({ resume: 1, silentTicks: 1 });
  });
});
