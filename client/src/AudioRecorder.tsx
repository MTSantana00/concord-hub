import { useEffect, useRef, useState } from "react";
import { AudioPlayer, formatDuration } from "./AudioPlayer";

export const MAX_RECORDING_MS = 5 * 60 * 1000;

const CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickMime(): string | undefined {
  return CANDIDATES.find((t) => MediaRecorder.isTypeSupported?.(t));
}

/** Mensagem clara para cada motivo de o microfone não abrir. */
export function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Permissão do microfone negada. Libere o microfone nas configurações do site e tente de novo.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Nenhum microfone encontrado neste dispositivo.";
  if (name === "NotReadableError") return "O microfone está em uso por outro programa.";
  return "Não foi possível abrir o microfone.";
}

type State =
  | { step: "idle" }
  | { step: "asking" }
  | { step: "recording"; startedAt: number }
  | { step: "review"; blob: Blob; url: string; durationMs: number };

/**
 * Botão de microfone para a caixa de mensagem: grava, deixa ouvir e só então envia.
 * `onSend` recebe o arquivo gravado e a duração; se falhar (lançar erro), a gravação é mantida para tentar de novo.
 */
export function AudioRecorder({
  onSend,
  disabled = false,
}: {
  onSend: (blob: Blob, durationMs: number) => Promise<void>;
  disabled?: boolean;
}) {
  const [state, setState] = useState<State>({ step: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const cancelled = useRef(false);
  const startedAt = useRef(0);
  const urlRef = useRef<string | null>(null);

  function releaseMic() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }

  function dropUrl() {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }

  // Ao sair da tela: solta o microfone e a memória da gravação
  useEffect(
    () => () => {
      cancelled.current = true;
      if (recorder.current?.state === "recording") recorder.current.stop();
      releaseMic();
      dropUrl();
    },
    [],
  );

  // Relógio da gravação, e parada automática no limite de 5 minutos
  useEffect(() => {
    if (state.step !== "recording") return;
    const timer = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(ms);
      if (ms >= MAX_RECORDING_MS) stop();
    }, 250);
    return () => clearInterval(timer);
  }, [state.step]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Este navegador não consegue gravar áudio. Use uma versão recente do Chrome, Edge, Firefox ou Safari.");
      return;
    }
    cancelled.current = false; // um "cancelar" anterior não vale para esta gravação
    setState({ step: "asking" });
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setError(micError(err));
      setState({ step: "idle" });
      return;
    }
    if (cancelled.current) {
      media.getTracks().forEach((t) => t.stop());
      return;
    }
    stream.current = media;
    chunks.current = [];
    const mime = pickMime();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(media, mime ? { mimeType: mime } : undefined);
    } catch {
      releaseMic();
      setError("Este navegador não consegue gravar áudio.");
      setState({ step: "idle" });
      return;
    }
    recorder.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      const durationMs = Math.min(MAX_RECORDING_MS, Math.max(1, Date.now() - startedAt.current));
      releaseMic();
      if (cancelled.current || chunks.current.length === 0) {
        setState({ step: "idle" });
        return;
      }
      const blob = new Blob(chunks.current, { type: rec.mimeType || mime || "audio/webm" });
      dropUrl();
      urlRef.current = URL.createObjectURL(blob);
      setState({ step: "review", blob, url: urlRef.current, durationMs });
    };
    startedAt.current = Date.now();
    setElapsed(0);
    rec.start();
    setState({ step: "recording", startedAt: startedAt.current });
  }

  function stop() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  function discard() {
    cancelled.current = true;
    if (recorder.current?.state === "recording") recorder.current.stop();
    releaseMic();
    dropUrl();
    chunks.current = [];
    setError(null);
    setState({ step: "idle" });
  }

  async function send() {
    if (state.step !== "review" || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(state.blob, state.durationMs);
      dropUrl();
      chunks.current = [];
      setState({ step: "idle" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível enviar o áudio");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="audio-recorder">
      {state.step === "idle" && (
        <button type="button" className="secondary" aria-label="Gravar mensagem de áudio" disabled={disabled} onClick={() => void start()}>
          🎤
        </button>
      )}
      {state.step === "asking" && <span className="muted">Aguardando permissão do microfone...</span>}
      {state.step === "recording" && (
        <div className="recording" role="group" aria-label="Gravando áudio">
          <span className="rec-dot" aria-hidden="true" />
          <span aria-label="Tempo de gravação">{formatDuration(elapsed)}</span>
          <button type="button" className="small" onClick={stop}>Parar</button>
          <button type="button" className="small secondary" onClick={discard}>Cancelar</button>
        </div>
      )}
      {state.step === "review" && (
        <div className="recording" role="group" aria-label="Áudio gravado">
          <AudioPlayer src={state.url} durationMs={state.durationMs} label="Ouvir antes de enviar" />
          <button type="button" className="small" disabled={sending} onClick={() => void send()}>
            {sending ? "Enviando..." : "Enviar áudio"}
          </button>
          <button type="button" className="small secondary" disabled={sending} onClick={discard}>Descartar</button>
        </div>
      )}
      {error && <p role="alert" className="error chat-error">{error}</p>}
    </div>
  );
}
