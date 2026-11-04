import { AccountNotices } from "./AccountNotices";
import { playCallSound } from "./sounds";
import { useHotkeys } from "./hotkeys";
import { QuickSwitcher } from "./QuickSwitcher";
import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { useAuth } from "./AuthContext";
import { Chat } from "./Chat";
import { DmList, useDms } from "./DmPanel";
import { MemberList } from "./MemberList";
import { ServerSettings } from "./ServerSettings";
import { Avatar, ServerScope, UserName, useProfiles } from "./profiles";
import { CategoryEditor, ChannelSettings, NewCategoryForm } from "./ChannelManager";
import { moveCategory, moveChannel, type OrderPayload } from "./order";
import { Badge, useNotify, type PlaceCount } from "./Notifications";
import { useSocket, type AdminAlert } from "./socket";
import { AccountSettings } from "./Account";
import { useServerAccess } from "./access";
import { CallBanner, useCalls } from "./Calls";
import { useIdleLeave } from "./idleLeave";
import { VideoGrid, VoiceBar, VoiceHandoff, VoiceParticipants, VoicePanel, useVoice, useVoiceCall } from "./VoiceChannel";

export interface Channel {
  id: number;
  name: string;
  /** Ausente = texto (servidores antigos). */
  type?: "text" | "voice";
  categoryId?: number | null;
  readOnly?: boolean;
  private?: boolean;
  /** Modo lento: segundos entre mensagens de cada pessoa (0 ou ausente = desligado). */
  slowmodeSeconds?: number;
  /** Descrição curta do canal, mostrada acima das mensagens. */
  topic?: string;
  /** Cargos que enxergam o canal privado (só chega para quem gerencia canais). */
  roleIds?: number[];
}

export interface ServerInfo {
  id: number;
  name: string;
  ownerId: number;
  channels: Channel[];
  /** 0 = sem ícone. */
  iconVersion?: number;
  categories?: { id: number; name: string }[];
}

function CreateServerForm({ onCreated, onCancel }: { onCreated: (s: ServerInfo) => void; onCancel?: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const d = await api<{ server: ServerInfo }>("/api/servers", "POST", { name });
      onCreated(d.server);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo deu errado");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>Criar um servidor</h2>
      <p className="muted">O seu espaço para conversar com os amigos.</p>
      <label>
        Nome do servidor
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} required autoFocus />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <button type="submit" disabled={busy}>Criar</button>
      {onCancel && <button type="button" className="link" onClick={onCancel}>Cancelar</button>}
    </form>
  );
}

function NewChannelForm({ serverId, categories, onCreated }: { serverId: number; categories: { id: number; name: string }[]; onCreated: (c: Channel) => void }) {
  const [open, setOpen] = useState(false);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [voice, setVoice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const d = await api<{ channel: Channel }>(`/api/servers/${serverId}/channels`, "POST", { name, ...(voice ? { type: "voice" } : {}), ...(categoryId !== null ? { categoryId } : {}) });
      onCreated(d.channel);
      setName("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível criar o canal");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="small add-channel" onClick={() => setOpen(true)}>
        + Novo canal
      </button>
    );
  }

  return (
    <form className="new-channel" onSubmit={onSubmit}>
      <input
        aria-label="Nome do canal"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={30}
        required
        autoFocus
      />
      <label className="check">
        <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
        Canal de voz
      </label>
      {categories.length > 0 && (
        <select aria-label="Categoria do canal" value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value === "" ? null : Number(e.target.value))}>
          <option value="">Sem categoria</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="row">
        <button type="submit" className="small" disabled={busy}>Criar canal</button>
        <button type="button" className="small secondary" onClick={() => { setOpen(false); setError(null); }}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

export function Workspace({ inviteCode = null }: { inviteCode?: string | null }) {
  const { user, logout, reload } = useAuth();
  const { learn } = useProfiles();
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [view, setView] = useState<"servers" | "dms">("servers");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [adminAlerts, setAdminAlerts] = useState<AdminAlert[]>([]);
  const [editingChannelId, setEditingChannelId] = useState<number | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<{ id: number; name: string } | null>(null);
  const [dragging, setDragging] = useState<{ kind: "channel" | "category"; id: number } | null>(null);
  const dmState = useDms();
  const { subscribe } = useSocket();
  const notify = useNotify();

  useEffect(() => {
    (async () => {
      let joinedId: number | null = null;
      if (inviteCode) {
        try {
          const j = await api<{ server: ServerInfo }>(`/api/invites/${encodeURIComponent(inviteCode)}/join`, "POST");
          joinedId = j.server.id;
        } catch (err) {
          setLoadError(err instanceof Error ? err.message : "Não foi possível usar o convite");
        }
        // tira o /convite/... da barra de endereço para um F5 não repetir o convite
        window.history.replaceState(null, "", "/");
      }
      try {
        const d = await api<{ servers: ServerInfo[] }>("/api/servers");
        setServers(d.servers);
        setSelectedId(joinedId ?? d.servers[0]?.id ?? null);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Não foi possível carregar os servidores");
      } finally {
        setLoaded(true);
      }
    })();
  }, [inviteCode]);

  // Meu próprio perfil entra no cadastro de pessoas; se mudou (neste ou em outro aparelho), releio quem sou eu
  // Canais ou cargos mudaram (alguém criou, apagou, tornou privado...): a lista de cada pessoa é refeita no servidor
  const refreshServers = useCallback(() => {
    api<{ servers: ServerInfo[] }>("/api/servers").then((d) => setServers(d.servers)).catch(() => {});
  }, []);
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "channels.changed" || event.type === "roles.changed") refreshServers();
      }),
    [subscribe, refreshServers],
  );

  // Administradora: avisos de limite (voz perto de acabar, VM sem memória...) aparecem no topo até serem marcados como lidos
  const isAdmin = !!user?.isAdmin;
  useEffect(() => {
    if (!isAdmin) return;
    api<{ alerts: AdminAlert[] }>("/api/admin/usage")
      .then((d) => setAdminAlerts(d.alerts.filter((a) => !a.acked)))
      .catch(() => {});
  }, [isAdmin]);
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "admin.alert") setAdminAlerts((prev) => [event.alert, ...prev.filter((a) => a.id !== event.alert.id)]);
      }),
    [subscribe],
  );
  async function ackAlerts() {
    setAdminAlerts([]);
    await api<void>("/api/admin/alerts/ack", "POST", {}).catch(() => {});
  }

  useEffect(() => {
    if (user) learn([{ id: user.id, username: user.username, displayName: user.displayName, about: user.about, statusKind: user.statusKind, statusText: user.statusText, avatarVersion: user.avatarVersion }]);
  }, [user, learn]);
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "profile.updated" && event.userId === user?.id) void reload();
        if (event.type === "voice.kicked") {
          setNotice("Você foi tirado da sala de voz por quem modera o servidor.");
          playCallSound("leave");
        }
        if (event.type === "server.updated") {
          setServers((prev) => prev.map((s) => (s.id === event.serverId ? { ...s, name: event.name, iconVersion: event.iconVersion } : s)));
        }
      }),
    [subscribe, user?.id, reload],
  );

  // Fui tirado de um servidor (expulso, banido ou saí por outro aparelho): ele some da lista
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type !== "member.removed" || event.userId !== user?.id) return;
        setServers((prev) => {
          const gone = prev.find((s) => s.id === event.serverId);
          if (gone && event.reason !== "left") {
            setNotice(`Você foi ${event.reason === "banned" ? "banido" : "expulso"} de "${gone.name}".`);
          }
          return prev.filter((s) => s.id !== event.serverId);
        });
        setSelectedId((cur) => (cur === event.serverId ? null : cur));
        setSettingsOpen(false);
      }),
    [subscribe, user?.id],
  );

  async function createInvite(serverId: number) {
    setInviteError(null);
    try {
      const d = await api<{ code: string }>(`/api/servers/${serverId}/invites`, "POST");
      setInviteLink(`${window.location.origin}/convite/${d.code}`);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Não foi possível criar o convite");
    }
  }

  function onCreated(s: ServerInfo) {
    setServers((prev) => [...prev, s]);
    setSelectedId(s.id);
    setCreating(false);
  }

  function onChannelCreated(serverId: number, channel: Channel) {
    setServers((prev) => prev.map((s) => (s.id === serverId ? { ...s, channels: [...s.channels, channel] } : s)));
    setChannelId(channel.id);
  }

  async function kickFromRoom(userId: number) {
    try {
      await api<void>("/api/voice/kick", "POST", { userId });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Não foi possível tirar a pessoa da sala");
    }
  }

  async function openDm(userId: number) {
    try {
      await dmState.open(userId);
      setView("dms");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Não foi possível abrir a conversa");
    }
  }

  const inDms = view === "dms";
  const dm = dmState.dms.find((d) => d.id === dmState.selectedId) ?? null;
  // Na aba de mensagens diretas nada de servidor fica à mostra
  const selected = inDms ? null : (servers.find((s) => s.id === selectedId) ?? servers[0] ?? null);
  // Se o canal escolhido não é deste servidor (ou ainda não há escolha), cai no primeiro
  const channel = selected?.channels.find((c) => c.id === channelId) ?? selected?.channels[0] ?? null;
  const isOwner = !!selected && selected.ownerId === user?.id;
  const access = useServerAccess(selected?.id ?? null, isOwner);
  const showCreate = !inDms && (creating || (loaded && !loadError && servers.length === 0));
  const voice = useVoice(selected?.id ?? null, user?.id);
  const [handoffDismissed, setHandoffDismissed] = useState<number | null>(null);
  /** No celular servidores e canais ficam num menu que abre por cima; a conversa ocupa a tela toda. */
  const [navOpen, setNavOpen] = useState(false);
  const calls = useCalls(user?.id, user?.statusKind === "dnd");
  const pickedChannel = channelId;
  const pickedDm = dmState.selectedId;
  useEffect(() => setNavOpen(false), [pickedChannel, pickedDm]);
  const modalOpen = settingsOpen || accountOpen || editingChannelId !== null || switcherOpen;
  useEffect(() => {
    if (modalOpen) setNavOpen(false);
  }, [modalOpen]);
  // Chamada na DM atendida tem prioridade; senão, a sala de voz em que estou
  const callTarget =
    calls.call?.state === "active"
      ? ({ kind: "dm", id: calls.call.dmId } as const)
      : voice.myRoomId !== null
        ? ({ kind: "channel", id: voice.myRoomId } as const)
        : null;
  const call = useVoiceCall(callTarget);
  // Sala de voz parada por 10 minutos (sozinho, mutado sem nada para assistir, ou todos calados): sai sozinho e economiza os minutos do plano
  const idle = useIdleLeave({
    enabled: callTarget?.kind === "channel" && call.status === "connected",
    alone: call.remotes.length === 0,
    meMuted: call.muted,
    someoneSpeaking: call.speaking.length > 0,
    anyVideo: call.videos.length > 0 && call.remotes.length > 0,
    onLeave: () => {
      voice.leave();
      setNotice("Você saiu da sala de voz por inatividade (assim os minutos gratuitos de voz duram mais). É só entrar de novo quando quiser.");
    },
  });
  /** Pula para o canal de texto anterior (-1) ou seguinte (+1) do servidor aberto. */
  const stepChannel = (delta: number) => {
    const texts = inDms ? [] : (selected?.channels.filter((c) => c.type !== "voice") ?? []);
    if (texts.length === 0) return;
    const at = texts.findIndex((c) => c.id === channel?.id);
    const next = at === -1 ? (delta > 0 ? 0 : texts.length - 1) : (at + delta + texts.length) % texts.length;
    setChannelId(texts[next].id);
  };
  const inCall = callTarget !== null && call.status === "connected";
  // Atalhos que cada pessoa configura em Minha conta → Atalhos (no app de computador os de chamada valem até em segundo plano)
  useHotkeys({
    quickSwitcher: () => setSwitcherOpen((v) => !v),
    prevChannel: () => stepChannel(-1),
    nextChannel: () => stepChannel(1),
    toggleMute: () => inCall && void call.toggleMute(),
    toggleDeafen: () => inCall && void call.toggleDeafen(),
    toggleCamera: () => inCall && void call.toggleCamera(),
    toggleScreen: () => inCall && void call.toggleScreen(),
    leaveCall: () => callTarget && (callTarget.kind === "dm" ? calls.hangup() : voice.leave()),
  });
  const activeText = inDms ? (dm ? ({ kind: "dm", id: dm.id } as const) : null) : !showCreate && channel && channel.type !== "voice" ? ({ kind: "channel", id: channel.id } as const) : null;
  const activeKind = activeText?.kind;
  const activeId = activeText?.id;
  useEffect(() => {
    notify.setActive(activeKind && activeId !== undefined ? { kind: activeKind, id: activeId } : null);
  }, [activeKind, activeId, notify.setActive]);
  /** Soma dos canais de texto de um servidor (os silenciados contam só como "novidade", sem número). */
  const serverCount = (s: ServerInfo): PlaceCount =>
    s.channels.filter((c) => c.type !== "voice").reduce<PlaceCount>((sum, c) => {
      const n = notify.count("channel", c.id);
      const mute = notify.isMuted("channel", c.id);
      return { unread: sum.unread + n.unread, mentions: sum.mentions + (n.mentions > 0 || !mute ? n.mentions : 0) };
    }, { unread: 0, mentions: 0 });
  const dmTotals = dmState.dms.reduce<PlaceCount>((sum, d) => {
    const n = notify.count("dm", d.id);
    return { unread: sum.unread + n.unread, mentions: sum.mentions + n.mentions };
  }, { unread: 0, mentions: 0 });
  const myRoomName = servers.flatMap((s) => s.channels).find((c) => c.id === voice.myRoomId)?.name ?? "";
  const barTitle = callTarget?.kind === "dm" ? `📞 ${calls.call?.peer.username ?? ""}` : `🔊 ${myRoomName}`;

  /** Canais agrupados: primeiro os sem categoria, depois cada categoria (vazia só aparece para quem gerencia). */
  const groups: { category: { id: number; name: string } | null; channels: Channel[] }[] = selected
    ? [
        { category: null, channels: selected.channels.filter((c) => !c.categoryId || !(selected.categories ?? []).some((k) => k.id === c.categoryId)) },
        ...(selected.categories ?? [])
          .map((k) => ({ category: k, channels: selected.channels.filter((c) => c.categoryId === k.id) }))
          .filter((g) => g.channels.length > 0 || access.can("manage_channels")),
      ]
    : [];
  /** Manda a nova ordem ao servidor e já mostra o resultado (o aviso 'channels.changed' confirma para os outros). */
  async function saveOrder(order: OrderPayload) {
    if (!selected) return;
    try {
      const d = await api<{ server: ServerInfo }>(`/api/servers/${selected.id}/order`, "PUT", order);
      setServers((prev) => prev.map((s) => (s.id === d.server.id ? d.server : s)));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Não foi possível reordenar");
      refreshServers();
    }
  }
  const canDrag = access.can("manage_channels");
  const dragProps = (kind: "channel" | "category", id: number, onDropHere: () => void) =>
    canDrag
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer?.setData("text/plain", `${kind}:${id}`);
            setDragging({ kind, id });
          },
          onDragEnd: () => setDragging(null),
          onDragOver: (e: React.DragEvent) => {
            if (dragging) e.preventDefault(); // permite soltar aqui
          },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            onDropHere();
            setDragging(null);
          },
        }
      : {};
  const flags = (c: Channel) => (c.private ? " 🔒" : "") + (c.readOnly ? " 📢" : "");

  const renderChannel = (c: Channel) => (
    <li
      key={c.id}
      className={dragging?.kind === "channel" && dragging.id === c.id ? "dragging" : undefined}
      {...dragProps("channel", c.id, () => {
        if (selected && dragging?.kind === "channel" && dragging.id !== c.id) void saveOrder(moveChannel(selected, dragging.id, c.categoryId ?? null, c.id));
      })}
    >
      <button
        type="button"
        className={`channel${c.id === channel?.id ? " active" : ""}${c.type !== "voice" && notify.count("channel", c.id).unread > 0 && !notify.isMuted("channel", c.id) ? " has-unread" : ""}`}
        aria-current={c.id === channel?.id ? "true" : undefined}
        title={[c.private ? "Privado" : "", c.readOnly ? "Somente leitura" : ""].filter(Boolean).join(" · ") || undefined}
        onClick={() => setChannelId(c.id)}
      >
        {c.type === "voice" ? `🔊 ${c.name}` : `# ${c.name}`}
        {flags(c)}
        {c.type !== "voice" && <Badge count={notify.count("channel", c.id)} muted={notify.isMuted("channel", c.id)} />}
      </button>
      {c.type !== "voice" && (
        <button
          type="button"
          className="small secondary mute-toggle"
          aria-pressed={notify.isMuted("channel", c.id)}
          aria-label={notify.isMuted("channel", c.id) ? `Reativar avisos de ${c.name}` : `Silenciar ${c.name}`}
          title={notify.isMuted("channel", c.id) ? "Reativar avisos" : "Silenciar canal"}
          onClick={() => notify.toggleMute("channel", c.id)}
        >
          {notify.isMuted("channel", c.id) ? "🔕" : "🔔"}
        </button>
      )}
      {access.can("manage_channels") && (
        <button type="button" className="small secondary mute-toggle" aria-label={`Configurar canal ${c.name}`} title="Configurar canal" onClick={() => setEditingChannelId(c.id)}>
          ⚙
        </button>
      )}
      {c.type === "voice" && (
        <VoiceParticipants
          participants={voice.rooms[c.id] ?? []}
          speaking={voice.myRoomId === c.id ? call.speaking : []}
          muted={voice.myRoomId === c.id ? call.mutedUsers : []}
        />
      )}
    </li>
  );

  return (
    <ServerScope.Provider value={inDms ? null : selected?.id ?? null}>
    <div className={`workspace${navOpen ? " nav-open" : ""}`}>
      <CallBanner calls={calls} />
      <header className="mobile-bar">
        <button type="button" className="mobile-menu" aria-label={navOpen ? "Fechar menu" : "Abrir menu"} aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
        <div className="mobile-title">
          <strong>{inDms ? (dm ? `@${dm.user.username}` : "Mensagens diretas") : channel ? (channel.type === "voice" ? `🔊 ${channel.name}` : `# ${channel.name}`) : "Concord Hub"}</strong>
          {!inDms && selected && <span className="muted">{selected.name}</span>}
        </div>
      </header>
      {navOpen && <button type="button" className="drawer-backdrop" aria-label="Fechar menu" onClick={() => setNavOpen(false)} />}
      <nav className="rail" aria-label="Servidores">
        <button
          type="button"
          className={"rail-item dm-home" + (inDms ? " active" : "")}
          title="Mensagens diretas"
          aria-label="Mensagens diretas"
          aria-current={inDms ? "true" : undefined}
          onClick={() => { setView("dms"); setCreating(false); }}
        >
          @
          <Badge count={dmTotals} muted={false} />
        </button>
        {servers.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`rail-item${s.id === selectedId && !creating && !inDms ? " active" : ""}`}
            title={s.name}
            aria-label={s.name}
            aria-current={s.id === selectedId && !creating && !inDms ? "true" : undefined}
            onClick={() => { setView("servers"); setSelectedId(s.id); setCreating(false); setInviteLink(null); setInviteError(null); }}
          >
            {s.iconVersion ? <img className="rail-icon" src={`/api/servers/${s.id}/icon?v=${s.iconVersion}`} alt="" /> : s.name.trim().charAt(0).toUpperCase()}
            <Badge count={serverCount(s)} muted={notify.isMuted("server", s.id)} />
          </button>
        ))}
        <button type="button" className="rail-item add" title="Criar servidor" aria-label="Criar servidor" onClick={() => { setView("servers"); setCreating(true); }}>
          +
        </button>
      </nav>

      <aside className="side">
        <header className="side-head">{inDms ? "Mensagens diretas" : selected && !showCreate ? selected.name : "Concord Hub"}</header>
        {selected && !showCreate && (
          <button type="button" className="small secondary settings-button" onClick={() => setSettingsOpen(true)}>
            ⚙ Servidor
          </button>
        )}
        {selected && !showCreate && (
          <button type="button" className="small secondary settings-button" aria-pressed={notify.isMuted("server", selected.id)} onClick={() => notify.toggleMute("server", selected.id)}>
            {notify.isMuted("server", selected.id) ? "🔕 Servidor silenciado" : "🔔 Silenciar servidor"}
          </button>
        )}
        {selected && !showCreate && access.can("invite") && (
          <div className="invite">
            <button type="button" className="small" onClick={() => void createInvite(selected.id)}>
              Convidar amigos
            </button>
            {inviteLink && (
              <>
                <input readOnly value={inviteLink} aria-label="Link de convite" onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="small" onClick={() => void navigator.clipboard?.writeText(inviteLink)}>
                  Copiar
                </button>
              </>
            )}
            {inviteError && <p role="alert" className="error">{inviteError}</p>}
          </div>
        )}
        {inDms && <DmList dms={dmState.dms} selectedId={dmState.selectedId} onSelect={dmState.select} />}
        {!inDms && (
        <ul className="channels" aria-label="Canais">
          {selected && !showCreate && (
            <>
              {groups.map((g) => (
                <Fragment key={g.category?.id ?? "sem"}>
                  {g.category && (
                    <li
                      className="category-head"
                      {...dragProps("category", g.category.id, () => {
                        if (!selected || !dragging) return;
                        if (dragging.kind === "category" && dragging.id !== g.category!.id) void saveOrder(moveCategory(selected, dragging.id, g.category!.id));
                        if (dragging.kind === "channel") void saveOrder(moveChannel(selected, dragging.id, g.category!.id, null));
                      })}
                    >
                      <span>{g.category.name}</span>
                      {access.can("manage_channels") && (
                        <button type="button" className="small secondary mute-toggle" aria-label={`Editar categoria ${g.category.name}`} onClick={() => setEditingCategory(g.category)}>
                          ✎
                        </button>
                      )}
                    </li>
                  )}
                  {g.channels.map(renderChannel)}
                </Fragment>
              ))}
            </>
          )}
          {selected && !showCreate && access.can("manage_channels") && (
            <li>
              <NewChannelForm key={selected.id} serverId={selected.id} categories={selected.categories ?? []} onCreated={(c) => onChannelCreated(selected.id, c)} />
              <NewCategoryForm key={`cat-${selected.id}`} serverId={selected.id} />
            </li>
          )}
        </ul>
        )}
        {selected && !showCreate && user && (
          <MemberList key={selected.id} serverId={selected.id} currentUserId={user.id} onMessage={(id) => void openDm(id)} />
        )}
        {callTarget === null && voice.elsewhere && handoffDismissed !== voice.elsewhere.channelId && (
          <VoiceHandoff
            roomName={servers.flatMap((s) => s.channels).find((c) => c.id === voice.elsewhere?.channelId)?.name ?? "uma sala"}
            onTake={voice.takeOver}
            onDismiss={() => setHandoffDismissed(voice.elsewhere?.channelId ?? null)}
          />
        )}
        {callTarget !== null && <VoiceBar title={barTitle} call={call} idle={callTarget.kind === "channel" ? idle : undefined} onLeave={callTarget.kind === "dm" ? calls.hangup : voice.leave} />}
        <div ref={call.audioBox} hidden />
        <footer className="user-bar">
          {user && <Avatar id={user.id} username={user.username} size={26} />}
          <span className="user-name">{user && <UserName id={user.id} username={user.username} />}</span>
          <button type="button" className="small secondary" aria-label="Minha conta" title="Minha conta" onClick={() => setAccountOpen(true)}>⚙</button>
          <button type="button" className="small" onClick={() => void logout()}>Sair</button>
        </footer>
      </aside>

      <section className="content">
        <AccountNotices onOpenAccount={() => setAccountOpen(true)} />
        {adminAlerts.length > 0 && (
          <div className="admin-alerts" role="alert">
            {adminAlerts.slice(0, 3).map((a) => (
              <p key={a.id} className={`admin-alert ${a.level}`}>
                <strong>⚠ {a.title}.</strong> {a.message}
              </p>
            ))}
            {adminAlerts.length > 3 && <p className="muted">... e mais {adminAlerts.length - 3} (veja em Minha conta → Administração).</p>}
            <button type="button" className="small" onClick={() => void ackAlerts()}>Marcar como lido</button>
          </div>
        )}
        {notice && (
          <p role="status" className="error">
            {notice} <button type="button" className="link" onClick={() => setNotice(null)}>Fechar</button>
          </p>
        )}
        {!loaded && <p className="muted">Carregando...</p>}
        {loadError && <p role="alert" className="error">{loadError}</p>}
        {showCreate && <CreateServerForm onCreated={onCreated} onCancel={servers.length > 0 ? () => setCreating(false) : undefined} />}
        {inDms && dmState.error && <p role="alert" className="error">{dmState.error}</p>}
        {inDms && dm && (
          <div className="dm-view">
            <header className="dm-head">
              <strong>@{dm.user.username}</strong>
              <button type="button" className="small secondary" aria-pressed={notify.isMuted("dm", dm.id)} onClick={() => notify.toggleMute("dm", dm.id)}>
                {notify.isMuted("dm", dm.id) ? "🔕 Silenciada" : "🔔 Silenciar"}
              </button>
              <button
                type="button"
                className="small"
                aria-label={`Ligar para ${dm.user.username}`}
                disabled={calls.call !== null}
                onClick={() => calls.start(dm.id)}
              >
                📞 Ligar
              </button>
            </header>
            {calls.call?.state === "active" && calls.call.dmId === dm.id && (
              <VideoGrid
                videos={call.videos}
                measures={call.measures}
                participants={[
                  { userId: user?.id ?? 0, username: user?.username ?? "" },
                  { userId: dm.user.id, username: dm.user.username },
                ]}
              />
            )}
            <Chat key={"dm-" + dm.id} kind="dm" channel={{ id: dm.id, name: dm.user.username }} />
          </div>
        )}
        {inDms && !dm && (
          <p className="muted">Escolha uma conversa, ou clique no nome de um membro de um servidor para começar uma.</p>
        )}
        {!showCreate && channel && channel.type === "voice" && (
          <VoicePanel
            key={channel.id}
            name={channel.name}
            participants={voice.rooms[channel.id] ?? []}
            speaking={voice.myRoomId === channel.id ? call.speaking : []}
            muted={voice.myRoomId === channel.id ? call.mutedUsers : []}
            videos={voice.myRoomId === channel.id ? call.videos : []}
            measures={call.measures}
            inRoom={voice.myRoomId === channel.id}
            error={voice.error}
            onKick={access.can("kick_ban") && user ? { run: (id) => void kickFromRoom(id), allowed: (id) => id !== user.id && id !== selected?.ownerId } : undefined}
            onJoin={() => voice.join(channel.id)}
            onLeave={voice.leave}
          />
        )}
        {!showCreate && channel && channel.type !== "voice" && <Chat key={channel.id} channel={channel} canModerate={access.can("manage_messages")} readOnly={!!channel.readOnly && !access.can("manage_channels")} />}
      </section>
      {switcherOpen && (
        <QuickSwitcher
          targets={servers.flatMap((s) => s.channels.filter((c) => c.type !== "voice").map((c) => ({ serverId: s.id, serverName: s.name, channelId: c.id, channelName: c.name })))}
          onClose={() => setSwitcherOpen(false)}
          onPick={(t) => {
            setView("servers");
            setCreating(false);
            setSelectedId(t.serverId);
            setChannelId(t.channelId);
            setSwitcherOpen(false);
          }}
        />
      )}
      {settingsOpen && selected && (
        <ServerSettings
          server={selected}
          isOwner={isOwner}
          access={access}
          onClose={() => setSettingsOpen(false)}
          onLeft={(id) => {
            setServers((prev) => prev.filter((s) => s.id !== id));
            setSelectedId(null);
            setSettingsOpen(false);
          }}
        />
      )}
      {accountOpen && <AccountSettings onClose={() => setAccountOpen(false)} />}
      {editingChannelId !== null && selected && selected.channels.some((c) => c.id === editingChannelId) && (
        <ChannelSettings
          server={selected}
          channel={selected.channels.find((c) => c.id === editingChannelId)!}
          roles={access.roles}
          onOrder={(o) => void saveOrder(o)}
          onClose={() => setEditingChannelId(null)}
        />
      )}
      {editingCategory && selected && <CategoryEditor server={selected} category={editingCategory} onOrder={(o) => void saveOrder(o)} onClose={() => setEditingCategory(null)} />}
    </div>
    </ServerScope.Provider>
  );
}
