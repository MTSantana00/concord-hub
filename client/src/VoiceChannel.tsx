import type { Room, VideoTrack } from "livekit-client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { micError } from "./AudioRecorder";
import { assess, describeMeasure, fpsBetween, screenCaptureOptions, screenPublishOptions, type Measure } from "./qualityMeter";
import { Avatar, UserName } from "./profiles";
import { getVoicePrefs, keyLabel, updateVoicePrefs, useVoicePrefs } from "./voicePrefs";
import { useSocket } from "./socket";
import { playCallSound } from "./sounds";

/** O LiveKit é pesado: só é baixado quando alguém entra numa sala de voz ou chamada. */
type LK = typeof import("livekit-client");

export interface VoiceParticipant {
  userId: number;
  username: string;
}

/**
 * Quem está em cada sala de voz de um servidor, ao vivo, e em qual sala EU estou (`mine`, de qualquer servidor).
 * Entrar e sair passam pelo WebSocket; a lista muda quando o servidor avisa (inclusive para quem entrou).
 */
export function useVoice(serverId: number | null, currentUserId: number | undefined) {
  const { epoch, subscribe, send } = useSocket();
  const [rooms, setRooms] = useState<Record<number, VoiceParticipant[]>>({});
  const [mine, setMine] = useState<{ serverId: number; channelId: number } | null>(null);
  /** Sala em que EU estou, mas por outro aparelho: este só entra se a pessoa pedir ("trocar de aparelho"). */
  const [elsewhere, setElsewhere] = useState<{ serverId: number; channelId: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Sala que ESTE aparelho pediu para entrar (só assim um aviso 'entrei' vira ligação aqui). */
  const asked = useRef<number | null>(null);
  const mineRef = useRef(mine);
  mineRef.current = mine;

  // Ao reconectar o servidor já tirou a gente da sala (a conexão que segurava a vaga caiu)
  useEffect(() => {
    setMine(null);
    setElsewhere(null);
    asked.current = null;
  }, [epoch]);

  // Estado inicial e a cada reconexão
  useEffect(() => {
    setRooms({});
    if (serverId === null) return;
    let cancelled = false;
    api<{ participants: { channelId: number; userId: number; username: string }[] }>(`/api/servers/${serverId}/voice`)
      .then((d) => {
        if (cancelled) return;
        const next: Record<number, VoiceParticipant[]> = {};
        for (const p of d.participants) (next[p.channelId] ??= []).push({ userId: p.userId, username: p.username });
        setRooms(next);
        const me = d.participants.find((p) => p.userId === currentUserId);
        // já estou na sala por outro aparelho: não entra sozinho, pergunta antes
        if (me && asked.current !== me.channelId) setElsewhere({ serverId, channelId: me.channelId });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [serverId, epoch, currentUserId]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "voice.joined") {
          if (event.user.id !== currentUserId && mineRef.current?.channelId === event.channelId) playCallSound("peer-join");
          if (event.user.id === currentUserId) {
            if (asked.current === event.channelId) {
              asked.current = null;
              setMine({ serverId: event.serverId, channelId: event.channelId });
              setElsewhere(null);
              playCallSound("join");
            } else {
              setElsewhere({ serverId: event.serverId, channelId: event.channelId });
            }
          }
          if (event.serverId !== serverId) return;
          setRooms((prev) => ({
            ...prev,
            [event.channelId]: [
              ...(prev[event.channelId] ?? []).filter((p) => p.userId !== event.user.id),
              { userId: event.user.id, username: event.user.username },
            ],
          }));
        } else if (event.type === "voice.left") {
          if (event.userId !== currentUserId && mineRef.current?.channelId === event.channelId) playCallSound("peer-leave");
          if (event.userId === currentUserId) {
            setMine((m) => (m?.channelId === event.channelId ? null : m));
            setElsewhere((e) => (e?.channelId === event.channelId ? null : e));
          }
          if (event.serverId !== serverId) return;
          setRooms((prev) => ({ ...prev, [event.channelId]: (prev[event.channelId] ?? []).filter((p) => p.userId !== event.userId) }));
        } else if (event.type === "voice.moved") {
          // outro aparelho assumiu a minha vaga: aqui a ligação acaba, mas dá para voltar
          if (mineRef.current?.channelId === event.channelId) {
            setElsewhere(mineRef.current);
            setMine(null);
          }
        } else if (event.type === "error") {
          setError(event.error);
        }
      }),
    [subscribe, serverId, currentUserId],
  );

  const join = useCallback(
    (channelId: number) => {
      setError(null);
      asked.current = channelId;
      if (!send({ type: "voice.join", channelId })) {
        asked.current = null;
        setError("Sem conexão com o servidor. Tente de novo em instantes.");
      }
    },
    [send],
  );
  const leave = useCallback(() => {
    setError(null);
    send({ type: "voice.leave" });
    playCallSound("leave");
  }, [send]);
  /** Puxa a ligação que estava em outro aparelho para este. */
  const takeOver = useCallback(() => {
    if (!elsewhere) return;
    setError(null);
    if (!send({ type: "voice.join", channelId: elsewhere.channelId })) {
      setError("Sem conexão com o servidor. Tente de novo em instantes.");
      return;
    }
    // na mesma sala o servidor não manda aviso de entrada: este aparelho assume direto
    setMine(elsewhere);
    setElsewhere(null);
    playCallSound("join");
  }, [send, elsewhere]);

  return { rooms, mine, elsewhere, myRoomId: mine?.channelId ?? null, join, leave, takeOver, error };
}

export interface CallState {
  status: "idle" | "connecting" | "connected" | "error";
  /** Microfone desligado (por escolha ou porque a permissão foi negada). */
  muted: boolean;
  message: string | null;
  /** O navegador bloqueou o som até o usuário clicar. */
  needsAudio: boolean;
  /** Ensurdecido: não ouve ninguém (e o microfone fica desligado). */
  deafened: boolean;
}

/** Um quadro de vídeo (câmera ou tela) de alguém na sala. */
export interface VideoEntry {
  userId: number;
  local: boolean;
  source: "camera" | "screen";
  track: VideoTrack;
}

/** Mensagem para cada motivo de a tela não ser compartilhada. */
function screenError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "AbortError") {
    return "O compartilhamento de tela foi cancelado ou a permissão foi negada.";
  }
  if (name === "NotFoundError") return "Nenhuma tela ou janela disponível para compartilhar.";
  if (name === "NotReadableError") return "Não foi possível capturar a tela escolhida.";
  if (name === "TypeError" || name === "NotSupportedError") return "Este navegador não permite compartilhar a tela.";
  return "Não foi possível compartilhar a tela.";
}

const MEASURE_EVERY_MS = 1000;

/** Mensagem clara para cada motivo de a câmera não abrir. */
function cameraError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Permissão da câmera negada. Libere a câmera nas configurações do site e tente de novo.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Nenhuma câmera encontrada neste dispositivo.";
  if (name === "NotReadableError") return "A câmera está em uso por outro programa.";
  return "Não foi possível abrir a câmera.";
}

const IDLE: CallState = { status: "idle", muted: false, message: null, needsAudio: false, deafened: false };

/** Quem está digitando em algum campo não deve disparar a tecla de falar. */
function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** Gente na sala (além de mim), para os ajustes de volume. */
export interface Remote {
  userId: number;
  name: string;
}

/**
 * Liga o áudio da sala de voz em que a pessoa está: pega a chave no servidor, conecta no LiveKit,
 * pede o microfone (o navegador pergunta; se negar, continua só ouvindo) e toca o áudio dos outros.
 */
export function useVoiceCall(target: { kind: "channel" | "dm"; id: number } | null) {
  const targetKind = target?.kind ?? null;
  const targetId = target?.id ?? null;
  const [state, setState] = useState<CallState>(IDLE);
  const [speaking, setSpeaking] = useState<number[]>([]);
  const [mutedUsers, setMutedUsers] = useState<number[]>([]);
  const [videos, setVideos] = useState<VideoEntry[]>([]);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraMessage, setCameraMessage] = useState<string | null>(null);
  const [screenOn, setScreenOn] = useState(false);
  const [screenMessage, setScreenMessage] = useState<string | null>(null);
  /** Resolução e fps medidos de cada tela compartilhada, por usuário. */
  const [measures, setMeasures] = useState<Record<number, Measure>>({});
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const room = useRef<Room | null>(null);
  const players = useRef(new Map<unknown, HTMLElement>());
  const audioTracks = useRef(new Map<unknown, number>());
  const deafenedRef = useRef(false);
  const micWasOffRef = useRef(false);
  const audioBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (targetKind === null || targetId === null) return;
    let cancelled = false;
    setState({ ...IDLE, status: "connecting" });
    const build = ({ Room, RoomEvent, Track }: LK) => {
    const prefs = getVoicePrefs();
    const r = new Room({
      audioCaptureDefaults: prefs.micId ? { deviceId: prefs.micId } : undefined,
      videoCaptureDefaults: prefs.camId ? { deviceId: prefs.camId } : undefined,
      audioOutput: prefs.speakerId ? { deviceId: prefs.speakerId } : undefined,
    });
    room.current = r;
    deafenedRef.current = false;
    micWasOffRef.current = false;

    // O LiveKit chama detach() sozinho ao parar a faixa, então guardamos o elemento para tirá-lo da página
    players.current = new Map();
    audioTracks.current = new Map();
    function applyVolume(track: unknown, el: HTMLElement, uid: number) {
      const v = (getVoicePrefs().volumes[String(uid)] ?? 100) / 100;
      const t = track as { setVolume?: (n: number) => void };
      if (typeof t.setVolume === "function") t.setVolume(v);
      else (el as HTMLMediaElement).volume = v;
    }
    r.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        players.current.set(track, el);
        el.muted = deafenedRef.current;
        const uid = Number(participant?.identity);
        audioTracks.current.set(track, uid);
        applyVolume(track, el, uid);
        audioBox.current?.appendChild(el);
      }
      refreshMuted(); // vídeo: o quadro é montado a partir da lista de faixas dos participantes
    });
    r.on(RoomEvent.TrackUnsubscribed, (track) => {
      players.current.get(track)?.remove();
      players.current.delete(track);
      audioTracks.current.delete(track);
      track.detach().forEach((el) => el.remove());
      refreshMuted();
    });
    r.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!cancelled) setState((s) => ({ ...s, needsAudio: !r.canPlaybackAudio }));
    });
    // Quem está com o microfone desligado, e quem está falando (a identidade no LiveKit é o id do usuário)
    const refreshMuted = () => {
      if (cancelled) return;
      const everyone = [r.localParticipant, ...(r.remoteParticipants ? [...r.remoteParticipants.values()] : [])];
      setMutedUsers(everyone.filter((p) => !p.isMicrophoneEnabled).map((p) => Number(p.identity)));
      const others = r.remoteParticipants ? [...r.remoteParticipants.values()] : [];
      setRemotes((prev) => {
        const next = others.map((p) => ({ userId: Number(p.identity), name: p.name || `Pessoa ${p.identity}` }));
        return prev.length === next.length && prev.every((x, i) => x.userId === next[i].userId && x.name === next[i].name) ? prev : next;
      });
      const found: VideoEntry[] = [];
      for (const p of everyone) {
        for (const [source, kind] of [
          [Track.Source.ScreenShare, "screen"],
          [Track.Source.Camera, "camera"],
        ] as const) {
          const pub = p.getTrackPublication(source);
          if (pub?.track && !pub.isMuted) {
            found.push({ userId: Number(p.identity), local: p === r.localParticipant, source: kind, track: pub.track as VideoTrack });
          }
        }
      }
      setVideos((prev) => (prev.length === found.length && prev.every((v, i) => v.track === found[i].track) ? prev : found));
      setCameraOn(r.localParticipant.isCameraEnabled);
      setScreenOn(r.localParticipant.isScreenShareEnabled);
    };
    for (const ev of [
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
    ]) {
      r.on(ev, refreshMuted);
    }
    r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (!cancelled) setSpeaking(speakers.map((p) => Number(p.identity)));
    });
    r.on(RoomEvent.Disconnected, () => {
      if (!cancelled) setState((s) => ({ ...s, status: "error", message: "A conexão de voz caiu." }));
    });
    return { r, refreshMuted };
    };

    (async () => {
      try {
        const lk = await import("livekit-client");
        if (cancelled) return;
        const { r, refreshMuted } = build(lk);
        const { token, url } = await api<{ token: string; url: string }>("/api/voice/token", "POST", targetKind === "dm" ? { dmId: targetId } : { channelId: targetId });
        await r.connect(url, token);
        if (cancelled) {
          void r.disconnect();
          return;
        }
        setState((s) => ({ ...s, status: "connected", needsAudio: !r.canPlaybackAudio }));
        refreshMuted();
        try {
          await r.localParticipant.setMicrophoneEnabled(true);
        } catch (err) {
          if (!cancelled) setState((s) => ({ ...s, muted: true, message: micError(err) + " Você continua ouvindo a sala." }));
        }
      } catch (err) {
        if (!cancelled) {
          setState({ ...IDLE, status: "error", message: err instanceof Error ? err.message : "Não foi possível entrar na voz." });
        }
      }
    })();

    return () => {
      cancelled = true;
      void room.current?.disconnect();
      room.current = null;
      audioBox.current?.replaceChildren();
      players.current = new Map();
      audioTracks.current = new Map();
      setRemotes([]);
      setState(IDLE);
      setSpeaking([]);
      setMutedUsers([]);
      setVideos([]);
      setCameraOn(false);
      setCameraMessage(null);
      setScreenOn(false);
      setScreenMessage(null);
      setMeasures({});
    };
  }, [targetKind, targetId]);

  const toggleMute = useCallback(async () => {
    const r = room.current;
    if (!r) return;
    const turningOn = state.muted;
    playCallSound(turningOn ? "unmute" : "mute"); // na hora, ainda dentro do toque
    try {
      await r.localParticipant.setMicrophoneEnabled(turningOn);
      setState((s) => ({ ...s, muted: !turningOn, message: null }));
    } catch (err) {
      setState((s) => ({ ...s, muted: true, message: micError(err) }));
    }
  }, [state.muted]);

  /** Muda o volume de uma pessoa (0 a 100); vale já e fica guardado. */
  const setPersonVolume = useCallback((userId: number, percent: number) => {
    updateVoicePrefs({ volumes: { ...getVoicePrefs().volumes, [String(userId)]: percent } });
    for (const [track, uid] of audioTracks.current) {
      if (uid !== userId) continue;
      const t = track as { setVolume?: (n: number) => void };
      const el = players.current.get(track) as HTMLMediaElement | undefined;
      if (typeof t.setVolume === "function") t.setVolume(percent / 100);
      else if (el) el.volume = percent / 100;
    }
  }, []);

  /** Ensurdecer: para de ouvir todos e desliga o microfone; ao voltar, o microfone volta como estava. */
  const toggleDeafen = useCallback(async () => {
    const r = room.current;
    if (!r) return;
    const on = !deafenedRef.current;
    deafenedRef.current = on;
    playCallSound(on ? "deafen" : "undeafen"); // na hora, ainda dentro do toque
    for (const el of players.current.values()) (el as HTMLMediaElement).muted = on;
    if (on) micWasOffRef.current = state.muted;
    try {
      if (on) await r.localParticipant.setMicrophoneEnabled(false);
      else if (!micWasOffRef.current) await r.localParticipant.setMicrophoneEnabled(true);
    } catch {
      // sem microfone: só o som foi cortado
    }
    setState((s) => ({ ...s, deafened: on, muted: on ? true : micWasOffRef.current }));
  }, [state.muted]);

  /** Troca de microfone, câmera ou caixa de som no meio da chamada. */
  const switchDevice = useCallback(async (kind: "audioinput" | "videoinput" | "audiooutput", deviceId: string) => {
    updateVoicePrefs(kind === "audioinput" ? { micId: deviceId } : kind === "videoinput" ? { camId: deviceId } : { speakerId: deviceId });
    try {
      await (room.current as unknown as { switchActiveDevice?: (k: string, id: string) => Promise<unknown> } | null)?.switchActiveDevice?.(kind, deviceId || "default");
    } catch {
      setState((s) => ({ ...s, message: "Não foi possível usar esse dispositivo. Escolha outro." }));
    }
  }, []);

  /** Liga ou desliga a câmera (só por clique; o navegador pede a permissão na primeira vez). */
  const toggleCamera = useCallback(async () => {
    const r = room.current;
    if (!r) return;
    setCameraMessage(null);
    try {
      await r.localParticipant.setCameraEnabled(!cameraOn);
      setCameraOn(!cameraOn);
      playCallSound(cameraOn ? "camera-off" : "camera-on");
    } catch (err) {
      setCameraMessage(cameraError(err));
    }
  }, [cameraOn]);

  /** Compartilha ou para de compartilhar a tela. O navegador mostra o seletor e só começa se a pessoa permitir. */
  const toggleScreen = useCallback(async () => {
    const r = room.current;
    if (!r) return;
    setScreenMessage(null);
    try {
      if (screenOn) await r.localParticipant.setScreenShareEnabled(false);
      else await r.localParticipant.setScreenShareEnabled(true, screenCaptureOptions, screenPublishOptions);
      setScreenOn(!screenOn);
      playCallSound(screenOn ? "screen-off" : "screen-on");
    } catch (err) {
      setScreenMessage(screenError(err));
    }
  }, [screenOn]);

  // Medidor: a cada segundo lê a resolução e os fps REAIS de cada tela (enviada por mim ou recebida)
  const screens = videos.filter((v) => v.source === "screen");
  useEffect(() => {
    if (screens.length === 0) {
      setMeasures((m) => (Object.keys(m).length === 0 ? m : {}));
      return;
    }
    let stopped = false;
    const previous = new Map<number, { frames: number; at: number }>();
    async function measure() {
      const next: Record<number, Measure> = {};
      for (const v of screens) {
        try {
          if (v.local) {
            const layers = await (v.track as unknown as { getSenderStats(): Promise<{ frameWidth: number; frameHeight: number; framesPerSecond: number; qualityLimitationReason?: string }[]> }).getSenderStats();
            const best = layers.filter(Boolean).sort((a, b) => b.frameHeight - a.frameHeight)[0];
            if (best?.frameWidth) {
              next[v.userId] = {
                width: best.frameWidth,
                height: best.frameHeight,
                fps: Math.round(best.framesPerSecond ?? 0),
                limit: best.qualityLimitationReason && best.qualityLimitationReason !== "none" ? best.qualityLimitationReason : undefined,
              };
            }
          } else {
            const st = await (v.track as unknown as { getReceiverStats(): Promise<{ frameWidth?: number; frameHeight?: number; framesDecoded: number } | undefined> }).getReceiverStats();
            if (st?.frameWidth && st.frameHeight) {
              const now = { frames: st.framesDecoded, at: Date.now() };
              next[v.userId] = { width: st.frameWidth, height: st.frameHeight, fps: fpsBetween(previous.get(v.userId), now) };
              previous.set(v.userId, now);
            }
          }
        } catch {
          // sem estatística agora: tenta de novo no próximo ciclo
        }
      }
      if (!stopped) setMeasures(next);
    }
    void measure();
    const timer = setInterval(() => void measure(), MEASURE_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos]);

  // Apertar para falar: com a opção ligada o microfone só abre enquanto a tecla está pressionada
  const prefs = useVoicePrefs();
  const pttActive = prefs.pushToTalk && state.status === "connected";
  useEffect(() => {
    if (!pttActive) return;
    const setMic = (on: boolean) => {
      if (deafenedRef.current && on) return;
      void room.current?.localParticipant.setMicrophoneEnabled(on).catch(() => {});
      setState((s) => ({ ...s, muted: !on }));
    };
    setMic(false);
    const down = (e: KeyboardEvent) => {
      if (e.code === prefs.pttKey && !e.repeat && !isTyping(e.target)) setMic(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === prefs.pttKey) setMic(false);
    };
    const release = () => setMic(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      setMic(true); // desligou a opção: volta a falar livremente
    };
  }, [pttActive, prefs.pttKey]);

  const enableAudio = useCallback(async () => {
    await room.current?.startAudio();
    setState((s) => ({ ...s, needsAudio: false }));
  }, []);

  return { ...state, remotes, setPersonVolume, toggleDeafen, switchDevice, speaking, mutedUsers, videos, cameraOn, cameraMessage, toggleCamera, screenOn, screenMessage, toggleScreen, measures, toggleMute, enableAudio, audioBox };
}

/** Lista de quem está na sala (abaixo do nome do canal). */
export function VoiceParticipants({
  participants,
  speaking = [],
  muted = [],
  action,
  variant = "list",
}: {
  /** "cards": fotos grandes (tela da sala); "list": lista compacta (lateral). */
  variant?: "list" | "cards";
  /** Botão extra ao lado de cada pessoa (ex.: tirar da sala). */
  action?: (p: VoiceParticipant) => ReactNode;
  participants: VoiceParticipant[];
  /** Quem está falando agora e quem está mutado (só se sabe isso na sala em que estou). */
  speaking?: number[];
  muted?: number[];
}) {
  if (participants.length === 0) return null;
  return (
    <ul className={`voice-participants${variant === "cards" ? " voice-cards" : ""}`} aria-label="Na sala de voz">
      {participants.map((p) => (
        <li key={p.userId} className={speaking.includes(p.userId) ? "speaking" : undefined}>
          <span className="voice-avatar">
            <Avatar id={p.userId} username={p.username} size={variant === "cards" ? 84 : 20} />
            {variant === "cards" && muted.includes(p.userId) && <span className="voice-mic-off" role="img" aria-label="microfone desligado" title="Microfone desligado">🔇</span>}
          </span>
          <span className="voice-name"><UserName id={p.userId} username={p.username} /></span>
          {variant === "list" && muted.includes(p.userId) && <span role="img" aria-label="microfone desligado" title="Microfone desligado"> 🔇</span>}
          {speaking.includes(p.userId) && <span className="sr-only"> (falando)</span>}
          {action?.(p)}
        </li>
      ))}
    </ul>
  );
}

/** Lista os microfones, câmeras e caixas de som do aparelho (os nomes só aparecem depois da permissão). */
function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const md = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    let alive = true;
    const load = () =>
      md
        .enumerateDevices()
        .then((d) => alive && setDevices(d))
        .catch(() => {});
    void load();
    md.addEventListener?.("devicechange", load);
    return () => {
      alive = false;
      md.removeEventListener?.("devicechange", load);
    };
  }, []);
  return devices;
}

/** Ajustes de voz: dispositivos, apertar para falar e volume de cada pessoa. */
function VoiceSettings({ call }: { call: ReturnType<typeof useVoiceCall> }) {
  const prefs = useVoicePrefs();
  const devices = useDevices();
  const [capturing, setCapturing] = useState(false);
  const canPickSpeaker = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code !== "Escape") updateVoicePrefs({ pttKey: e.code });
      setCapturing(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]);

  const select = (label: string, kind: "audioinput" | "videoinput" | "audiooutput", value: string) => {
    const list = devices.filter((d) => d.kind === kind);
    return (
      <label className="voice-select">
        {label}
        <select value={list.some((d) => d.deviceId === value) ? value : ""} onChange={(e) => void call.switchDevice(kind, e.target.value)}>
          <option value="">Padrão do sistema</option>
          {list.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `${label} ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <details className="voice-settings">
      <summary>⚙ Ajustes de voz</summary>
      {select("Microfone", "audioinput", prefs.micId)}
      {select("Câmera", "videoinput", prefs.camId)}
      {canPickSpeaker && select("Caixa de som", "audiooutput", prefs.speakerId)}
      <label className="check">
        <input type="checkbox" checked={prefs.pushToTalk} onChange={(e) => updateVoicePrefs({ pushToTalk: e.target.checked })} />
        Falar só segurando uma tecla
      </label>
      {prefs.pushToTalk && (
        <button type="button" className="small secondary" onClick={() => setCapturing(true)}>
          {capturing ? "Aperte a nova tecla (Esc cancela)" : `Tecla de falar: ${keyLabel(prefs.pttKey)} (trocar)`}
        </button>
      )}
      {call.remotes.length > 0 && <strong className="voice-volumes-title">Volume de cada pessoa</strong>}
      {call.remotes.map((p) => (
        <label key={p.userId} className="voice-volume">
          <span>{p.name}</span>
          <input
            type="range"
            min={0}
            max={100}
            aria-label={`Volume de ${p.name}`}
            value={prefs.volumes[String(p.userId)] ?? 100}
            onChange={(e) => call.setPersonVolume(p.userId, Number(e.target.value))}
          />
        </label>
      ))}
    </details>
  );
}

/** Botão quadrado só com ícone (o nome fica no aria-label e na dica); `off` risca o ícone, `on` acende. */
function ControlButton({
  label,
  children,
  on,
  off,
  danger,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  children: ReactNode;
  on?: boolean;
  off?: boolean;
  danger?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`ctl${on ? " on" : ""}${off ? " off" : ""}${danger ? " danger" : ""}`}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
        {off && <path d="M4 4l16 16" />}
      </svg>
    </button>
  );
}

/** Aviso quando a minha voz está em outro aparelho: este só assume se a pessoa pedir. */
export function VoiceHandoff({ roomName, onTake, onDismiss }: { roomName: string; onTake: () => void; onDismiss: () => void }) {
  return (
    <div className="voice-handoff" role="alertdialog" aria-label="Trocar de aparelho">
      <p>Você já está em 🔊 {roomName} em outro aparelho. Deseja trocar de aparelho?</p>
      <div className="row">
        <button type="button" className="small" onClick={onTake}>Trocar para este</button>
        <button type="button" className="small secondary" onClick={onDismiss}>Agora não</button>
      </div>
    </div>
  );
}

/** Barra fixa na lateral enquanto a pessoa está numa sala: estado da ligação, mutar e sair. */
export function VoiceBar({
  title,
  call,
  idle,
  onLeave,
}: {
  title: string;
  call: ReturnType<typeof useVoiceCall>;
  /** Aviso de saída por inatividade (só em sala de voz). */
  idle?: { secondsLeft: number | null; keepGoing: () => void };
  onLeave: () => void;
}) {
  const status =
    call.status === "connecting" ? "Conectando..." : call.status === "connected" ? "Voz conectada" : "Sem conexão de voz";
  const ready = call.status === "connected";
  return (
    <div className="voice-bar" role="group" aria-label="Chamada de voz">
      <div className="voice-bar-title">{title}</div>
      <div className="muted voice-bar-status">{status}</div>
      <div className="voice-controls">
        <ControlButton label={call.muted ? "Ativar microfone" : "Mutar"} off={call.muted} disabled={!ready} onClick={() => void call.toggleMute()}>
          <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M6 11a6 6 0 0 0 12 0 M12 17v4" />
        </ControlButton>
        <ControlButton label={call.deafened ? "Voltar a ouvir" : "Ensurdecer"} off={call.deafened} pressed={call.deafened} disabled={!ready} onClick={() => void call.toggleDeafen()}>
          <path d="M4 14v-2a8 8 0 0 1 16 0v2 M4 14h3v5H5a1 1 0 0 1-1-1v-4Z M20 14h-3v5h2a1 1 0 0 0 1-1v-4Z" />
        </ControlButton>
        <ControlButton label={call.cameraOn ? "Desligar câmera" : "Ligar câmera"} on={call.cameraOn} disabled={!ready} onClick={() => void call.toggleCamera()}>
          <path d="M3 7h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z M15 11l6-3v8l-6-3" />
        </ControlButton>
        <ControlButton label={call.screenOn ? "Parar de compartilhar" : "Compartilhar tela"} on={call.screenOn} disabled={!ready} onClick={() => void call.toggleScreen()}>
          <path d="M3 5h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z M8 21h8 M12 17v4" />
        </ControlButton>
        <ControlButton label="Desconectar" danger onClick={onLeave}>
          <path d="M3 12c5-5 13-5 18 0l-3 3-3-2v-2a9 9 0 0 0-6 0v2l-3 2-3-3Z" />
        </ControlButton>
      </div>
      {call.needsAudio && (
        <button type="button" className="small" onClick={() => void call.enableAudio()}>Ativar o som da sala</button>
      )}
      {idle?.secondsLeft != null && (
        <div role="alert" className="idle-warning">
          <span>Sala parada: você sai em {idle.secondsLeft}s para poupar os minutos gratuitos.</span>
          <button type="button" className="small" onClick={idle.keepGoing}>Continuar na sala</button>
        </div>
      )}
      {call.status === "connected" && <VoiceSettings call={call} />}
      {call.message && <p role="alert" className="error">{call.message}</p>}
      {call.cameraMessage && <p role="alert" className="error">{call.cameraMessage}</p>}
      {call.screenMessage && <p role="alert" className="error">{call.screenMessage}</p>}
    </div>
  );
}

/** Um quadro de vídeo: liga a faixa do LiveKit ao elemento <video>. */
function VideoTile({ entry, name, measure }: { entry: VideoEntry; name: string; measure?: Measure }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    entry.track.attach(el);
    return () => {
      entry.track.detach(el);
    };
  }, [entry.track]);
  const screen = entry.source === "screen";
  const verdict = screen && measure ? assess(measure) : null;
  return (
    <figure className={`video-tile${screen ? " screen" : ""}`} aria-label={`${screen ? "Tela" : "Câmera"} de ${name}`}>
      <video ref={ref} autoPlay playsInline muted className={entry.local && !screen ? "mirror" : undefined} />
      <figcaption>{entry.local ? `${name} (você)` : name}</figcaption>
      {screen && (
        <div className={`quality ${verdict ? (verdict.ok ? "ok" : "low") : ""}`} role="status" aria-label="Qualidade da tela">
          {measure ? describeMeasure(measure) : "Medindo..."}
          {verdict && !verdict.ok && <span className="quality-note">{verdict.note}</span>}
        </div>
      )}
    </figure>
  );
}

/** Grade de câmeras e telas de quem está na sala ou na chamada. */
export function VideoGrid({
  videos,
  measures,
  participants,
}: {
  videos: VideoEntry[];
  measures: Record<number, Measure>;
  participants: VoiceParticipant[];
}) {
  if (videos.length === 0) return null;
  return (
    <div className="video-grid" aria-label="Câmeras">
      {videos.map((v) => (
        <VideoTile
          key={`${v.userId}-${v.source}`}
          entry={v}
          name={participants.find((p) => p.userId === v.userId)?.username ?? "Alguém"}
          measure={v.source === "screen" ? measures[v.userId] : undefined}
        />
      ))}
    </div>
  );
}

/** Painel de um canal de voz: no lugar do chat de texto. */
export function VoicePanel({
  name,
  participants,
  speaking,
  muted,
  videos = [],
  measures = {},
  inRoom,
  error,
  onJoin,
  onLeave,
  onKick,
}: {
  /** Quem modera pode tirar outras pessoas da sala (devolve false para quem não pode ser tirado). */
  onKick?: { run: (userId: number) => void; allowed: (userId: number) => boolean };
  name: string;
  participants: VoiceParticipant[];
  speaking?: number[];
  muted?: number[];
  videos?: VideoEntry[];
  measures?: Record<number, Measure>;
  inRoom: boolean;
  error: string | null;
  onJoin: () => void;
  onLeave: () => void;
}) {
  return (
    <div className="voice-panel">
      <h2>🔊 {name}</h2>
      <p className="muted">
        {participants.length === 0
          ? "Ninguém na sala ainda."
          : `${participants.length} ${participants.length === 1 ? "pessoa" : "pessoas"} na sala:`}
      </p>
      <VoiceParticipants
        variant="cards"
        participants={participants}
        speaking={speaking}
        muted={muted}
        action={
          onKick
            ? (p) =>
                onKick.allowed(p.userId) ? (
                  <button type="button" className="small danger" aria-label={`Tirar ${p.username} da sala`} onClick={() => onKick.run(p.userId)}>
                    Tirar da sala
                  </button>
                ) : null
            : undefined
        }
      />
      <VideoGrid videos={videos} measures={measures} participants={participants} />
      {inRoom ? (
        <button type="button" className="danger" onClick={onLeave}>Sair da sala</button>
      ) : (
        <button type="button" onClick={onJoin}>Entrar na sala</button>
      )}
      <p className="muted voice-note">Ao entrar, o navegador pede a permissão do microfone.</p>
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}
