import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Avatar, UserName, useProfiles } from "./profiles";
import { Badge, useNotify } from "./Notifications";
import { useSocket } from "./socket";

export interface Dm {
  id: number;
  user: { id: number; username: string; online: boolean; displayName?: string | null; about?: string; statusKind?: string; statusText?: string; avatarVersion?: number };
}

/** Conversas diretas: a lista, qual está aberta, e como abrir uma com alguém. */
export function useDms() {
  const { epoch, subscribe } = useSocket();
  const [dms, setDms] = useState<Dm[]>([]);
  const { learn } = useProfiles();
  useEffect(() => learn(dms.map((d) => ({ ...d.user }))), [dms, learn]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const known = useRef<Set<number>>(new Set());

  useEffect(() => {
    known.current = new Set(dms.map((d) => d.id));
  }, [dms]);

  const reload = useCallback(() => {
    api<{ dms: Dm[] }>("/api/dms")
      .then((d) => {
        // Mantém as conversas abertas agora que ainda não têm mensagem (o servidor só lista as com mensagem)
        setDms((prev) => [...d.dms, ...prev.filter((p) => !d.dms.some((n) => n.id === p.id))]);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Não foi possível carregar as conversas"));
  }, []);

  // Ao entrar e a cada reconexão
  useEffect(() => {
    reload();
  }, [reload, epoch]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "presence.updated") {
          setDms((prev) => prev.map((d) => (d.user.id === event.userId ? { ...d, user: { ...d.user, online: event.online } } : d)));
        } else if (event.type === "message.created" && event.message.dmId != null) {
          const dmId = event.message.dmId;
          if (!known.current.has(dmId)) {
            reload(); // alguém falou comigo pela primeira vez
          } else {
            // a conversa com mensagem nova sobe para o topo
            setDms((prev) => {
              const hit = prev.find((d) => d.id === dmId);
              return hit ? [hit, ...prev.filter((d) => d.id !== dmId)] : prev;
            });
          }
        }
      }),
    [subscribe, reload],
  );

  /** Abre (ou cria) a conversa com a pessoa e a deixa selecionada. */
  const open = useCallback(async (userId: number) => {
    const d = await api<{ dm: Dm }>("/api/dms", "POST", { userId });
    setDms((prev) => (prev.some((p) => p.id === d.dm.id) ? prev : [d.dm, ...prev]));
    setSelectedId(d.dm.id);
  }, []);

  return { dms, selectedId, select: setSelectedId, open, error };
}

export function DmList({ dms, selectedId, onSelect }: { dms: Dm[]; selectedId: number | null; onSelect: (id: number) => void }) {
  const notify = useNotify();
  return (
    <ul className="channels" aria-label="Conversas">
      {dms.map((d) => (
        <li key={d.id}>
          <button
            type="button"
            className={`channel dm${d.id === selectedId ? " active" : ""}${notify.count("dm", d.id).unread > 0 && !notify.isMuted("dm", d.id) ? " has-unread" : ""}`}
            aria-current={d.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(d.id)}
          >
            <span className={`dot ${d.user.online ? "on" : "off"}`} role="img" aria-label={d.user.online ? "online" : "offline"} />
            <Avatar id={d.user.id} username={d.user.username} size={20} />
            <UserName id={d.user.id} username={d.user.username} />
            <Badge count={notify.count("dm", d.id)} muted={notify.isMuted("dm", d.id)} />
          </button>
        </li>
      ))}
      {dms.length === 0 && <li className="muted empty-dms">Nenhuma conversa ainda. Clique no nome de um membro para começar.</li>}
    </ul>
  );
}
