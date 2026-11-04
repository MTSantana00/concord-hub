import { useState, type FormEvent } from "react";

export interface Poll {
  /** true = dá para votar em várias opções. */
  multiple: boolean;
  options: { id: number; text: string; users: number[] }[];
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

/** A enquete dentro da mensagem: barras com a porcentagem; clicar numa opção vota (clicar de novo tira o voto). */
export function PollCard({ poll, userId, onVote }: { poll: Poll; userId: number | undefined; onVote: (optionId: number) => void }) {
  const voters = new Set(poll.options.flatMap((o) => o.users)).size;
  const total = poll.options.reduce((n, o) => n + o.users.length, 0);
  return (
    <div className="poll" role="group" aria-label="Enquete">
      {poll.options.map((o) => {
        const mine = userId !== undefined && o.users.includes(userId);
        const pct = total === 0 ? 0 : Math.round((o.users.length / total) * 100);
        return (
          <button
            key={o.id}
            type="button"
            className={`poll-option${mine ? " mine" : ""}`}
            aria-pressed={mine}
            aria-label={`${o.text}: ${o.users.length} ${o.users.length === 1 ? "voto" : "votos"} (${pct}%)${mine ? ", seu voto" : ""}`}
            onClick={() => onVote(o.id)}
          >
            <span className="poll-bar" style={{ width: `${pct}%` }} aria-hidden="true" />
            <span className="poll-text">{mine ? "✓ " : ""}{o.text}</span>
            <span className="poll-count">{o.users.length} · {pct}%</span>
          </button>
        );
      })}
      <small className="muted">
        {voters} {voters === 1 ? "pessoa votou" : "pessoas votaram"} · {poll.multiple ? "escolha quantas quiser" : "escolha uma opção"}
      </small>
    </div>
  );
}

/** Formulário para criar uma enquete (pergunta, de 2 a 10 opções, escolha única ou várias). */
export function PollForm({ onCreate, onCancel }: { onCreate: (p: { question: string; options: string[]; multiple: boolean }) => Promise<void>; onCancel: () => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ question: question.trim(), options: filled, multiple });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível criar a enquete");
      setBusy(false);
    }
  }

  return (
    <form className="poll-form" onSubmit={submit} aria-label="Nova enquete">
      <strong>📊 Nova enquete</strong>
      <input aria-label="Pergunta da enquete" placeholder="Pergunta" value={question} maxLength={200} onChange={(e) => setQuestion(e.target.value)} autoFocus />
      {options.map((o, i) => (
        <div className="poll-form-row" key={i}>
          <input
            aria-label={`Opção ${i + 1}`}
            placeholder={`Opção ${i + 1}`}
            value={o}
            maxLength={80}
            onChange={(e) => setOptions((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
          />
          {options.length > MIN_OPTIONS && (
            <button type="button" className="small secondary" aria-label={`Remover opção ${i + 1}`} onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}>✕</button>
          )}
        </div>
      ))}
      {options.length < MAX_OPTIONS && (
        <button type="button" className="small secondary" onClick={() => setOptions((prev) => [...prev, ""])}>+ Adicionar opção</button>
      )}
      <label className="poll-multiple">
        <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} /> Permitir escolher várias opções
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="poll-form-row">
        <button type="submit" disabled={busy || question.trim() === "" || filled.length < MIN_OPTIONS}>Criar enquete</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}
