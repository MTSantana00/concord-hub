import { useEffect, useRef, useState } from "react";

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Toca um áudio com play/pausa, barra de progresso e tempo. A duração vem de fora (`durationMs`):
 * gravações do MediaRecorder não trazem a duração no arquivo, então `audio.duration` não é confiável.
 */
export function AudioPlayer({ src, durationMs, label = "Mensagem de áudio" }: { src: string; durationMs: number; label?: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0); // ms
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setPlaying(false);
    setPosition(0);
    setFailed(false);
  }, [src]);

  async function toggle() {
    const el = ref.current;
    if (!el) return;
    if (playing) {
      el.pause();
      return;
    }
    try {
      await el.play();
    } catch {
      setFailed(true);
    }
  }

  function seek(ms: number) {
    const el = ref.current;
    if (el) el.currentTime = ms / 1000;
    setPosition(ms);
  }

  return (
    <div className="audio-player" role="group" aria-label={label}>
      <audio
        ref={ref}
        src={src}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
        }}
        onTimeUpdate={(e) => setPosition(Math.min(durationMs, e.currentTarget.currentTime * 1000))}
        onError={() => setFailed(true)}
      />
      <button type="button" className="small secondary" aria-label={playing ? "Pausar" : "Tocar"} onClick={() => void toggle()}>
        {playing ? "⏸" : "▶"}
      </button>
      <input
        type="range"
        aria-label="Posição do áudio"
        min={0}
        max={durationMs}
        step={100}
        value={Math.min(position, durationMs)}
        onChange={(e) => seek(Number(e.target.value))}
      />
      <span className="audio-time">
        {formatDuration(position)} / {formatDuration(durationMs)}
      </span>
      {failed && <span role="alert" className="error">Não foi possível tocar o áudio</span>}
    </div>
  );
}
