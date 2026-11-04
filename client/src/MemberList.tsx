import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Avatar, UserName, useProfiles } from "./profiles";
import { useSocket, type Member } from "./socket";

export function MemberList({
  serverId,
  currentUserId,
  onMessage,
}: {
  serverId: number;
  currentUserId: number;
  /** Chamado ao clicar no nome de outro membro (abre a conversa direta). */
  onMessage?: (userId: number) => void;
}) {
  const { epoch, subscribe } = useSocket();
  const [members, setMembers] = useState<Member[]>([]);
  const { learn, get, learnNicknames } = useProfiles();
  useEffect(() => learn(members.map((m) => ({ ...m }))), [members, learn]);
  useEffect(() => learnNicknames(serverId, members), [members, serverId, learnNicknames]);
  const [error, setError] = useState<string | null>(null);

  // Retrato inicial, e de novo a cada reconexão (pode ter perdido avisos)
  useEffect(() => {
    let cancelled = false;
    api<{ members: Member[] }>(`/api/servers/${serverId}/members`)
      .then((d) => {
        if (cancelled) return;
        setMembers(d.members);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Não foi possível carregar os membros");
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, epoch]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "presence.updated") {
          setMembers((prev) => prev.map((m) => (m.id === event.userId ? { ...m, online: event.online } : m)));
        } else if (event.type === "member.joined" && event.serverId === serverId) {
          setMembers((prev) => (prev.some((m) => m.id === event.member.id) ? prev : [...prev, event.member]));
        } else if (event.type === "member.removed" && event.serverId === serverId) {
          setMembers((prev) => prev.filter((m) => m.id !== event.userId));
        } else if (event.type === "member.timeout" && event.serverId === serverId) {
          setMembers((prev) => prev.map((m) => (m.id === event.userId ? { ...m, timeoutUntil: event.timeoutUntil } : m)));
        } else if (event.type === "roles.changed" && event.serverId === serverId) {
          api<{ members: Member[] }>(`/api/servers/${serverId}/members`).then((d) => setMembers(d.members)).catch(() => {});
        }
      }),
    [subscribe, serverId],
  );

  // Quem está com o app aberto está online, mesmo que o retrato tenha chegado antes do socket conectar
  const sorted = useMemo(
    () =>
      members
        .map((m) => (m.id === currentUserId ? { ...m, online: true } : m))
        .sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username, "pt-BR")),
    [members, currentUserId],
  );
  const onlineCount = sorted.filter((m) => m.online).length;

  return (
    <section className="members" aria-label="Membros">
      <h3>Membros — {onlineCount} online</h3>
      {error && <p role="alert" className="error">{error}</p>}
      <ul>
        {sorted.map((m) => {
          const profile = get(m.id); // o que chegou ao vivo vale mais que o retrato da lista
          const statusKind = profile?.statusKind ?? m.statusKind;
          const statusText = profile?.statusText ?? m.statusText;
          return (
          <li key={m.id} className={m.online ? "member" : "member offline"}>
            <Avatar id={m.id} username={m.username} size={22} />
            <span className={`dot ${m.online ? "on" : "off"}${statusKind === "away" ? " away" : statusKind === "dnd" ? " dnd" : ""}`} role="img" aria-label={m.online ? "online" : "offline"} />
            {onMessage && m.id !== currentUserId ? (
              <button
                type="button"
                className="member-name member-link"
                aria-label={"Mensagem direta para " + m.username}
                onClick={() => onMessage(m.id)}
              >
                <UserName id={m.id} username={m.username} />
              </button>
            ) : (
              <span className="member-name"><UserName id={m.id} username={m.username} /></span>
            )}
            {statusText && <span className="status-text" title={statusText}>{statusText}</span>}
            {m.timeoutUntil != null && m.timeoutUntil > Date.now() && <span className="badge timeout" title={`Em timeout até ${new Date(m.timeoutUntil).toLocaleString("pt-BR")}`}>⏳ timeout</span>}
            {m.isOwner && <span className="badge">dono</span>}
            {!m.isOwner && m.roleName && m.roleName !== "Membro" && <span className="badge role">{m.roleName}</span>}
          </li>
          );
        })}
      </ul>
    </section>
  );
}
