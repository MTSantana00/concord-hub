// "Ouvir como os outros me ouvem": abre o microfone, passa (ou não) pelo mesmo filtro de ruído da chamada e toca na hora.
// Serve para a pessoa ouvir a diferença com e sem o filtro e ver se o filtro realmente liga no aparelho dela.
import { getVoicePrefs } from "./voicePrefs";

export interface MicTest {
  stop: () => void;
}

export async function startMicTest(filtered: boolean): Promise<MicTest> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador não deixa usar o microfone aqui.");
  const prefs = getVoicePrefs();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { ...(prefs.micId ? { deviceId: { exact: prefs.micId } } : {}), noiseSuppression: prefs.noiseSuppression, echoCancellation: prefs.echoCancellation },
  });
  type Proc = { destroy?: () => Promise<void> | void; init: (o: never) => Promise<void>; processedTrack?: MediaStreamTrack };
  let processor = null as Proc | null;
  try {
    let track = stream.getAudioTracks()[0];
    if (filtered) {
      const { createNoiseProcessor } = await import("./noiseProcessor");
      const proc = createNoiseProcessor() as unknown as Proc;
      processor = proc;
      await proc.init({ kind: "audio", track } as never);
      if (!proc.processedTrack) throw new Error("O filtro não gerou áudio.");
      track = proc.processedTrack;
    }
    const el = new Audio();
    el.srcObject = new MediaStream([track]);
    await el.play();
    return {
      stop() {
        el.pause();
        el.srcObject = null;
        stream.getTracks().forEach((t) => t.stop());
        void processor?.destroy?.();
      },
    };
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    void processor?.destroy?.();
    throw err;
  }
}
