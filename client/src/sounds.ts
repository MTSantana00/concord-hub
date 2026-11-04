import { getNotifyPrefs } from "./notifyPrefs";

export type SoundKind = "message" | "mention" | CallSound;
/** Avisos da chamada: cada ação tem o seu desenho de notas (subindo = ligou, descendo = desligou). */
export type CallSound =
  | "join" | "leave" | "mute" | "unmute" | "deafen" | "undeafen" | "camera-on" | "camera-off" | "screen-on" | "screen-off"
  | "ring-in" | "ring-out" | "call-connected" | "call-end" | "peer-join" | "peer-leave";

/** Notas (em Hz) de cada aviso, tocadas em sequência. */
const NOTES: Record<SoundKind, number[]> = {
  message: [660],
  mention: [880, 1175],
  join: [440, 660, 880],
  leave: [600, 450, 300],
  mute: [520, 390],
  unmute: [390, 520],
  deafen: [440, 330, 247],
  undeafen: [247, 330, 440],
  "camera-on": [600, 900],
  "camera-off": [900, 600],
  "screen-on": [500, 750, 1000],
  "screen-off": [1000, 750, 500],
  "ring-in": [880, 660, 880, 660], // chamada recebida: toca de novo a cada 2 s
  "ring-out": [440, 480], // chamando: sinal de "chamando", de novo a cada 3 s
  "call-connected": [523, 659, 784],
  "call-end": [500, 400, 300],
  "peer-join": [660, 880], // alguém entrou na sala em que estou
  "peer-leave": [660, 440], // alguém saiu da sala em que estou
};

const isCall = (kind: SoundKind): kind is CallSound => kind !== "message" && kind !== "mention";

let ctx: AudioContext | null = null;

/** Esquece o contexto de áudio guardado (os testes trocam o AudioContext por um falso a cada teste). */
export function resetSoundContext() {
  ctx = null;
}

function audioContext(): AudioContext | null {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  return ctx;
}

/**
 * Libera o áudio do navegador. O Safari do iPhone e o Chrome só deixam tocar depois de um toque da pessoa, e um som pedido
 * depois de um `await` já não conta como toque: por isso o contexto é criado e acordado no primeiro toque na tela.
 * No iPhone, `audioSession.type = "playback"` faz o som tocar mesmo com o aparelho no silencioso.
 */
export function unlockAudio() {
  try {
    const c = audioContext();
    if (!c) return;
    if (c.state === "suspended") void c.resume();
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) session.type = "playback";
    const tick = c.createBufferSource(); // um instante de silêncio termina de destravar o iOS
    tick.buffer = c.createBuffer(1, 1, 22050);
    tick.connect(c.destination);
    tick.start(0);
  } catch {
    // sem áudio disponível: tudo bem
  }
}

/** Liga a liberação do áudio ao primeiro toque, clique ou tecla; sai de cena assim que o áudio está rodando. */
export function installAudioUnlock() {
  const events = ["pointerdown", "touchend", "click", "keydown"] as const;
  const handler = () => {
    unlockAudio();
    if (ctx?.state === "running") for (const e of events) window.removeEventListener(e, handler, true);
  };
  for (const e of events) window.addEventListener(e, handler, true);
}

/** Toca um aviso curto gerado na hora (sem arquivos de áudio). Falha em silêncio se o navegador não deixar. */
export function playSound(kind: SoundKind, volume: number) {
  try {
    const c = audioContext();
    if (!c) return;
    if (c.state === "suspended") void c.resume();
    // os avisos da chamada são mais curtos e graves: precisam de um pouco mais de volume para se ouvirem no alto-falante do celular
    const peak = Math.max(0.0002, (Math.min(100, Math.max(0, volume)) / 100) * (isCall(kind) ? 0.55 : 0.3));
    const step = isCall(kind) ? 0.1 : 0.12;
    NOTES[kind].forEach((freq, i) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const t = c.currentTime + i * step;
      osc.type = isCall(kind) ? "triangle" : "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  } catch {
    // sem áudio disponível: tudo bem
  }
}

/** Aviso de uma ação da chamada (mutar, ensurdecer, câmera, tela, entrar, sair), se a pessoa não desligou. */
export function playCallSound(kind: CallSound) {
  const prefs = getNotifyPrefs();
  if (prefs.callSounds) playSound(kind, prefs.volume);
}
