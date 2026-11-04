import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

export interface SwitchTarget {
  serverId: number;
  serverName: string;
  channelId: number;
  channelName: string;
}

/** Tira acentos e maiúsculas para a busca achar "cafe" em "Café". */
const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Canais que combinam com o texto (nome do canal ou do servidor); canal que começa com o texto vem primeiro. */
export function filterTargets(targets: SwitchTarget[], query: string, limit = 12): SwitchTarget[] {
  const q = plain(query.trim().replace(/^#/, ""));
  if (!q) return targets.slice(0, limit);
  const scored: [number, SwitchTarget][] = [];
  for (const t of targets) {
    const name = plain(t.channelName);
    const server = plain(t.serverName);
    if (name.startsWith(q)) scored.push([0, t]);
    else if (name.includes(q)) scored.push([1, t]);
    else if (server.includes(q)) scored.push([2, t]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, t]) => t);
}

/** Ctrl+K: pula para qualquer canal de texto de qualquer servidor. */
export function QuickSwitcher({ targets, onPick, onClose }: { targets: SwitchTarget[]; onPick: (t: SwitchTarget) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => filterTargets(targets, query), [targets, query]);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActive(0), [query]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      onPick(results[active]);
    }
  }

  return (
    <div className="modal-backdrop quick-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal quick-switcher" role="dialog" aria-modal="true" aria-label="Ir para um canal" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          aria-label="Buscar canal"
          placeholder="Ir para um canal…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
        <ul role="listbox" aria-label="Canais">
          {results.map((t, i) => (
            <li key={t.channelId} role="option" aria-selected={i === active}>
              <button type="button" className={`quick-item${i === active ? " active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => onPick(t)}>
                <span># {t.channelName}</span> <span className="muted">{t.serverName}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="muted">Nenhum canal encontrado.</li>}
        </ul>
        <small className="muted">↑ ↓ para escolher, Enter para ir, Esc para fechar</small>
      </div>
    </div>
  );
}
