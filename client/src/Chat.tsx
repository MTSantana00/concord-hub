import { useCallback, useContext, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { api, uploadAudio, uploadFile } from "./api";
import { AudioPlayer } from "./AudioPlayer";
import { AudioRecorder } from "./AudioRecorder";
import { useAuth } from "./AuthContext";
import { EMOJIS } from "./emojis";
import { LinkPreview } from "./LinkPreview";
import { PollCard, PollForm } from "./Poll";
import { mentionsUser } from "./Notifications";
import { applyMention, filterMembers, mentionQuery } from "./mentions";
import { Avatar, ServerScope, UserName, useNameOf, useProfiles } from "./profiles";
import { RichText, extractLinks } from "./RichText";
import { useSocket, type Member, type Message, type Reaction } from "./socket";
import { COMMANDS, localCommand, parsePollCommand, suggestions } from "./slashCommands";

const MAX_LENGTH = 2000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const TYPING_SHOW_MS = 6000;
const TYPING_SEND_MS = 2000;

/** Junta listas de mensagens sem repetir ids, em ordem; a versão mais nova de um id vence. */
function merge(a: Message[], b: Message[]): Message[] {
  const byId = new Map<number, Message>();
  for (const m of [...a, ...b]) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.id - y.id);
}

/**
 * Atualiza com o que o servidor devolveu (a página mais recente): troca o trecho que ela cobre, para
 * sumirem mensagens apagadas enquanto estávamos offline, e mantém o que é mais antigo (já carregado
 * pelo usuário) ou mais novo (chegou por evento durante a busca).
 */
function mergeWindow(prev: Message[], fetched: Message[]): Message[] {
  if (fetched.length === 0) return prev;
  const min = fetched[0].id;
  const max = fetched[fetched.length - 1].id;
  return merge(
    prev.filter((m) => m.id < min || m.id > max),
    fetched,
  );
}

/** 5 -> "5 s", 90 -> "1 min 30 s", 3600 -> "1 h". */
function formatSlowmode(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h && `${h} h`, m && `${m} min`, s && `${s} s`].filter(Boolean).join(" ");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const summary = (m: Message) => m.content || (m.attachment ? `📎 ${m.attachment.name}` : m.audio ? "🎤 Mensagem de voz" : "");

/** Linha compacta de uma mensagem nos painéis de busca e de fixadas. */
function MessageLine({ m, onJump }: { m: Message; onJump: (id: number) => void }) {
  return (
    <li className="panel-line">
      <button type="button" className="link" onClick={() => onJump(m.id)} aria-label={`Ir para a mensagem de ${m.author.username}`}>
        <strong><UserName id={m.author.id} username={m.author.username} /></strong>{" "}
        <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</time>
        <span className="panel-text">{summary(m)}</span>
      </button>
    </li>
  );
}

/**
 * Conversa de um canal de servidor (padrão) ou uma conversa direta (kind="dm"; name = o outro usuário).
 * `canModerate`: quem pode apagar e fixar mensagens dos outros (nos canais, por cargo).
 */
export function Chat({
  kind = "channel",
  channel,
  canModerate = false,
  readOnly = false,
}: {
  kind?: "channel" | "dm";
  channel: { id: number; name: string; slowmodeSeconds?: number; topic?: string };
  canModerate?: boolean;
  /** Canal somente leitura para quem está vendo: sem campo para escrever. */
  readOnly?: boolean;
}) {
  const isDm = kind === "dm";
  const basePath = isDm ? `/api/dms/${channel.id}` : `/api/channels/${channel.id}`;
  const title = isDm ? `@${channel.name}` : `# ${channel.name}`;
  const { user } = useAuth();
  const { epoch, subscribe, send } = useSocket();
  const [messages, setMessages] = useState<Message[]>([]);
  const { learn } = useProfiles();
  const nameOf = useNameOf();
  useEffect(() => learn(messages.map((m) => ({ ...m.author }))), [messages, learn]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const serverScope = useContext(ServerScope);
  const [members, setMembers] = useState<Member[]>([]);
  const [caret, setCaret] = useState(0);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionHidden, setMentionHidden] = useState<number | null>(null); // posição do "@" que a pessoa dispensou com Esc
  const inputRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [pending, setPending] = useState<{ file: File; previewUrl: string | null } | null>(null);
  const [pickerFor, setPickerFor] = useState<number | "composer" | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [lightbox, setLightbox] = useState<{ id: number; name: string } | null>(null);
  const [panel, setPanel] = useState<"search" | "pins" | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Message[] | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [pins, setPins] = useState<Message[] | null>(null);
  const [typers, setTypers] = useState<Record<number, string>>({});
  const [dragging, setDragging] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const keepFromBottom = useRef<number | null>(null); // distância até o fim, ao carregar mensagens antigas
  const lastSeenId = useRef<number | null>(null);
  const typingTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const lastTypingSent = useRef(0);

  const clearTyper = useCallback((userId: number) => {
    clearTimeout(typingTimers.current.get(userId));
    typingTimers.current.delete(userId);
    setTypers((t) => {
      if (!(userId in t)) return t;
      const { [userId]: _gone, ...rest } = t;
      return rest;
    });
  }, []);

  // Trocar de canal/conversa: limpa o que era da anterior
  useEffect(() => {
    setReplyingTo(null);
    setPanel(null);
    setQuery("");
    setResults(null);
    setPins(null);
    setPickerFor(null);
    setTypers({});
    for (const t of typingTimers.current.values()) clearTimeout(t);
    typingTimers.current.clear();
  }, [basePath]);
  useEffect(
    () => () => {
      for (const t of typingTimers.current.values()) clearTimeout(t);
    },
    [],
  );
  useEffect(() => {
    if (!pending?.previewUrl) return;
    const url = pending.previewUrl;
    return () => URL.revokeObjectURL(url);
  }, [pending]);

  // Histórico: ao abrir o canal e a cada reconexão (pode ter perdido mensagens)
  useEffect(() => {
    let cancelled = false;
    api<{ messages: Message[]; hasMore: boolean }>(`${basePath}/messages`)
      .then((d) => {
        if (cancelled) return;
        // Se o usuário já carregou mensagens mais antigas que esta página, quem diz se há mais é ele.
        // As duas atualizações abaixo saem juntas, num único render (senão o botão "carregar
        // anteriores" aparece depois da rolagem e o fim da lista fica fora de vista).
        const loadedOlder = d.messages.length > 0 && messagesRef.current.some((m) => m.id < d.messages[0].id);
        if (!loadedOlder) setHasMore(d.hasMore);
        setMessages((prev) => mergeWindow(prev, d.messages));
        setLoadError(null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Não foi possível carregar as mensagens");
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [basePath, epoch]);

  // Tempo real: mensagens novas, editadas, apagadas, reações e "digitando" deste canal/conversa
  useEffect(
    () =>
      subscribe((event) => {
        const here = (place: { channelId?: number | null; dmId?: number | null }) =>
          isDm ? place.dmId === channel.id : place.channelId === channel.id;
        if (event.type === "message.created" || event.type === "message.updated") {
          const m = event.message;
          if (!here(m)) return;
          setMessages((prev) => merge(prev, [m]));
          setPins((p) => (p === null ? p : m.pinned ? merge(p.filter((x) => x.id !== m.id), [m]) : p.filter((x) => x.id !== m.id)));
          if (event.type === "message.created") clearTyper(m.author.id);
        } else if (event.type === "message.deleted") {
          if (!here(event)) return;
          setMessages((prev) => prev.filter((m) => m.id !== event.id));
          setPins((p) => (p === null ? p : p.filter((m) => m.id !== event.id)));
          setEditing((e) => (e?.id === event.id ? null : e));
          setConfirmingId((c) => (c === event.id ? null : c));
          setReplyingTo((r) => (r?.id === event.id ? null : r));
        } else if (event.type === "message.reactions") {
          if (!here(event)) return;
          setMessages((prev) => prev.map((m) => (m.id === event.messageId ? { ...m, reactions: event.reactions } : m)));
        } else if (event.type === "typing") {
          if (!here(event)) return;
          setTypers((t) => ({ ...t, [event.userId]: event.username }));
          clearTimeout(typingTimers.current.get(event.userId));
          typingTimers.current.set(event.userId, setTimeout(() => clearTyper(event.userId), TYPING_SHOW_MS));
        }
      }),
    [subscribe, channel.id, isDm, clearTyper],
  );

  // Rolagem: vai para o fim quando chega mensagem nova; ao carregar antigas, mantém o que o usuário lia
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    } else if (lastId !== lastSeenId.current) {
      el.scrollTop = el.scrollHeight;
    }
    lastSeenId.current = lastId;
  }, [messages, lastId]);

  // Esc fecha a imagem ampliada
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setLightbox(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  async function loadOlder() {
    if (loadingMore || messages.length === 0) return;
    setLoadingMore(true);
    setActionError(null);
    try {
      const d = await api<{ messages: Message[]; hasMore: boolean }>(`${basePath}/messages?before=${messages[0].id}`);
      const el = listRef.current;
      keepFromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
      setMessages((prev) => merge(prev, d.messages));
      setHasMore(d.hasMore);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Não foi possível carregar as mensagens anteriores");
    } finally {
      setLoadingMore(false);
    }
  }

  function choose(file: File | undefined) {
    if (!file) return;
    setSendError(null);
    if (file.size === 0) return setSendError("Esse arquivo está vazio");
    if (file.size > MAX_FILE_BYTES) return setSendError("O arquivo é grande demais (limite de 8 MB)");
    const isImg = /^image\/(png|jpe?g|webp|gif)$/.test(file.type);
    setPending({ file, previewUrl: isImg ? URL.createObjectURL(file) : null });
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const file = e.clipboardData?.files?.[0];
    if (file) {
      e.preventDefault();
      choose(file);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    choose(e.dataTransfer?.files?.[0]);
  }

  // Quem dá para mencionar: os membros do servidor deste canal (nas conversas diretas não há lista)
  useEffect(() => {
    if (isDm || serverScope === null) return;
    let alive = true;
    api<{ members: Member[] }>(`/api/servers/${serverScope}/members`)
      .then((d) => alive && setMembers(d.members))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isDm, serverScope, epoch]);
  const mention = isDm ? null : mentionQuery(text, caret);
  const mentionMatches = mention && mentionHidden !== mention.start ? filterMembers(members, mention.query) : [];
  const mentionPick = mentionMatches[Math.min(mentionIdx, mentionMatches.length - 1)];
  function pickMention(username: string) {
    if (!mention) return;
    const next = applyMention(text, mention.start, caret, username);
    setText(next.text);
    setCaret(next.caret);
    setMentionIdx(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  }
  function onComposerKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (mentionMatches.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setMentionIdx((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + mentionMatches.length) % mentionMatches.length);
    } else if ((e.key === "Enter" || e.key === "Tab") && mentionPick) {
      e.preventDefault();
      pickMention(mentionPick.username);
    } else if (e.key === "Escape" && mention) {
      e.preventDefault();
      setMentionHidden(mention.start);
    }
  }

  function onType(value: string) {
    setText(value);
    const now = Date.now();
    if (value.trim() !== "" && now - lastTypingSent.current > TYPING_SEND_MS) {
      lastTypingSent.current = now;
      send(isDm ? { type: "typing", dmId: channel.id } : { type: "typing", channelId: channel.id });
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const content = text.trim();
    if ((!content && !pending) || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const local = pending ? null : localCommand(content);
      if (local && !(isDm && local.command.channelOnly)) {
        if (local.command.local === "help") {
          setHelpOpen(true);
        } else {
          const poll = parsePollCommand(local.arg);
          if (typeof poll === "string") throw new Error(poll);
          await createPoll(poll);
        }
        setText("");
        return;
      }
      let d: { message: Message };
      if (pending) {
        d = await uploadFile<{ message: Message }>(`${basePath}/attachments`, pending.file, {
          name: pending.file.name || "arquivo",
          caption: content,
          replyTo: replyingTo?.id,
        });
      } else {
        d = await api<{ message: Message }>(`${basePath}/messages`, "POST", replyingTo ? { content, replyTo: replyingTo.id } : { content });
      }
      setMessages((prev) => merge(prev, [d.message]));
      setText("");
      setPending(null);
      setReplyingTo(null);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Não foi possível enviar");
    } finally {
      setSending(false);
    }
  }

  async function sendAudio(blob: Blob, durationMs: number) {
    const d = await uploadAudio<{ message: Message }>(`${basePath}/audio`, blob, durationMs);
    setMessages((prev) => merge(prev, [d.message]));
  }

  async function saveEdit(original: Message) {
    if (!editing) return;
    const content = editing.text.trim();
    if (content === original.content) {
      setEditing(null);
      return;
    }
    setActionError(null);
    try {
      const d = await api<{ message: Message }>(`${basePath}/messages/${original.id}`, "PATCH", { content });
      setMessages((prev) => merge(prev, [d.message]));
      setEditing(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Não foi possível editar");
    }
  }

  async function remove(id: number) {
    setActionError(null);
    try {
      await api<void>(`${basePath}/messages/${id}`, "DELETE");
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setConfirmingId(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Não foi possível apagar");
    }
  }

  async function react(messageId: number, emoji: string) {
    setPickerFor(null);
    setActionError(null);
    try {
      const d = await api<{ reactions: Reaction[] }>(`${basePath}/messages/${messageId}/reactions`, "POST", { emoji });
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions: d.reactions } : m)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Não foi possível reagir");
    }
  }

  async function vote(messageId: number, optionId: number) {
    setActionError(null);
    try {
      const d = await api<{ message: Message }>(`${basePath}/messages/${messageId}/vote`, "POST", { optionId });
      setMessages((prev) => merge(prev, [d.message]));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Não foi possível votar");
    }
  }

  async function createPoll(p: { question: string; options: string[]; multiple: boolean }) {
    const d = await api<{ message: Message }>(`${basePath}/polls`, "POST", p);
    setMessages((prev) => merge(prev, [d.message]));
    setPollOpen(false);
  }

  async function togglePin(m: Message) {
    setActionError(null);
    try {
      const d = await api<{ message: Message }>(`${basePath}/messages/${m.id}/pin`, m.pinned ? "DELETE" : "PUT");
      setMessages((prev) => merge(prev, [d.message]));
      setPins((p) => (p === null ? p : d.message.pinned ? merge(p, [d.message]) : p.filter((x) => x.id !== m.id)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Não foi possível fixar");
    }
  }

  function jumpTo(id: number) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) {
      setActionError("Essa mensagem é mais antiga: carregue as anteriores para vê-la na conversa");
      return;
    }
    setActionError(null);
    el.scrollIntoView?.({ block: "center" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1500);
  }

  async function runSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    setPanel("search");
    setPanelError(null);
    if (q.length < 2) {
      setResults(null);
      setPanelError("Digite pelo menos 2 letras para buscar");
      return;
    }
    try {
      const d = await api<{ messages: Message[] }>(`${basePath}/search?q=${encodeURIComponent(q)}`);
      setResults(d.messages);
    } catch (err) {
      setResults(null);
      setPanelError(err instanceof Error ? err.message : "Não foi possível buscar");
    }
  }

  async function openPins() {
    if (panel === "pins") return setPanel(null);
    setPanel("pins");
    setPanelError(null);
    try {
      setPins((await api<{ messages: Message[] }>(`${basePath}/pins`)).messages);
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : "Não foi possível carregar as fixadas");
    }
  }

  function onEditKey(e: KeyboardEvent<HTMLInputElement>, original: Message) {
    if (e.key === "Escape") setEditing(null);
    if (e.key === "Enter") {
      e.preventDefault();
      void saveEdit(original);
    }
  }

  const canPin = isDm || canModerate;
  const typingNames = Object.entries(typers)
    .filter(([id]) => Number(id) !== user?.id)
    .map(([id, name]) => nameOf(Number(id), name));
  const typingText =
    typingNames.length === 0
      ? ""
      : typingNames.length === 1
        ? `${typingNames[0]} está digitando...`
        : typingNames.length === 2
          ? `${typingNames[0]} e ${typingNames[1]} estão digitando...`
          : "Várias pessoas estão digitando...";

  return (
    <div
      className={`chat${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      {!isDm && !!channel.topic && <p className="channel-topic" title={channel.topic}>{channel.topic}</p>}
      <div className="chat-tools">
        <form className="search-form" role="search" onSubmit={runSearch}>
          <input
            type="search"
            aria-label="Buscar mensagens"
            placeholder="Buscar nesta conversa"
            value={query}
            maxLength={100}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
        <button type="button" className="small secondary" aria-pressed={panel === "pins"} onClick={() => void openPins()}>
          📌 Fixadas
        </button>
      </div>
      {panel && (
        <section className="side-panel" aria-label={panel === "pins" ? "Mensagens fixadas" : "Resultados da busca"}>
          <header>
            <strong>{panel === "pins" ? "Mensagens fixadas" : "Resultados da busca"}</strong>
            <button type="button" className="small secondary" aria-label="Fechar painel" onClick={() => setPanel(null)}>✕</button>
          </header>
          {panelError && <p role="alert" className="error">{panelError}</p>}
          {!panelError && (panel === "pins" ? pins : results) === null && <p className="muted">Carregando...</p>}
          {!panelError && (panel === "pins" ? pins : results)?.length === 0 && (
            <p className="muted">{panel === "pins" ? "Nenhuma mensagem fixada ainda." : "Nada encontrado."}</p>
          )}
          <ul>
            {!panelError && (panel === "pins" ? pins : results)?.map((m) => <MessageLine key={m.id} m={m} onJump={jumpTo} />)}
          </ul>
        </section>
      )}
      <ol className="messages" ref={listRef} aria-label="Mensagens">
        {hasMore && (
          <li className="load-older">
            <button type="button" className="link" onClick={() => void loadOlder()} disabled={loadingMore}>
              {loadingMore ? "Carregando..." : "Carregar mensagens anteriores"}
            </button>
          </li>
        )}
        {messages.map((m) => {
          const mine = m.author.id === user?.id;
          const isEditing = editing?.id === m.id;
          const firstLink = !isEditing && m.content ? extractLinks(m.content)[0] : undefined;
          const reactions = m.reactions ?? [];
          return (
            <li key={m.id} id={`msg-${m.id}`} tabIndex={-1} className={`message${!mine && user && m.content && mentionsUser(m.content, user.username) ? " mention-me" : ""}`}>
              {m.replyTo && (
                <button type="button" className="reply-quote" onClick={() => jumpTo(m.replyTo!.id)} aria-label="Ir para a mensagem respondida">
                  {m.replyTo.deleted || !m.replyTo.author ? (
                    <em>Mensagem apagada</em>
                  ) : (
                    <>
                      <strong><UserName id={m.replyTo.author.id} username={m.replyTo.author.username} /></strong> {m.replyTo.snippet}
                    </>
                  )}
                </button>
              )}
              <div className="message-head">
                <Avatar id={m.author.id} username={m.author.username} size={24} />
                <strong><UserName id={m.author.id} username={m.author.username} /></strong>
                <time dateTime={m.createdAt}>{formatTime(m.createdAt)}</time>
                {m.editedAt && <span className="edited">(editada)</span>}
                {m.pinned && <span className="pinned-mark" title="Mensagem fixada">📌 Fixada</span>}
                {!isEditing && confirmingId !== m.id && (
                  <span className="message-actions">
                    <button type="button" className="small secondary" aria-label="Responder mensagem" onClick={() => setReplyingTo(m)}>
                      Responder
                    </button>
                    <button
                      type="button"
                      className="small secondary"
                      aria-label="Adicionar reação"
                      aria-expanded={pickerFor === m.id}
                      onClick={() => setPickerFor(pickerFor === m.id ? null : m.id)}
                    >
                      😊
                    </button>
                    {canPin && (
                      <button type="button" className="small secondary" aria-label={m.pinned ? "Desafixar mensagem" : "Fixar mensagem"} onClick={() => void togglePin(m)}>
                        {m.pinned ? "Desafixar" : "Fixar"}
                      </button>
                    )}
                    {mine && !m.audio && (
                      <button
                        type="button"
                        className="small secondary"
                        aria-label="Editar mensagem"
                        onClick={() => { setEditing({ id: m.id, text: m.content }); setConfirmingId(null); setActionError(null); }}
                      >
                        Editar
                      </button>
                    )}
                    {(mine || canModerate) && (
                      <button
                        type="button"
                        className="small secondary"
                        aria-label="Apagar mensagem"
                        onClick={() => { setConfirmingId(m.id); setEditing(null); setActionError(null); }}
                      >
                        Apagar
                      </button>
                    )}
                  </span>
                )}
              </div>
              {isEditing ? (
                <div className="edit-row">
                  <input
                    aria-label="Novo texto da mensagem"
                    value={editing.text}
                    maxLength={MAX_LENGTH}
                    autoFocus
                    onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                    onKeyDown={(e) => onEditKey(e, m)}
                  />
                  <button type="button" className="small" disabled={editing.text.trim() === "" && !m.attachment} onClick={() => void saveEdit(m)}>
                    Salvar
                  </button>
                  <button type="button" className="small secondary" onClick={() => setEditing(null)}>
                    Cancelar
                  </button>
                </div>
              ) : m.audio ? (
                <AudioPlayer src={`/api/audio/${m.id}`} durationMs={m.audio.durationMs} label={`Áudio de ${m.author.username}`} />
              ) : (
                m.content && <p className="message-body"><RichText text={m.content} /></p>
              )}
              {m.poll && <PollCard poll={m.poll} userId={user?.id} onVote={(optionId) => void vote(m.id, optionId)} />}
              {m.attachment &&
                (m.attachment.kind === "image" ? (
                  <button type="button" className="att-image" aria-label={`Ampliar imagem ${m.attachment.name}`} onClick={() => setLightbox({ id: m.id, name: m.attachment!.name })}>
                    <img src={`/api/files/${m.id}`} alt={m.attachment.name} loading="lazy" />
                  </button>
                ) : (
                  <a className="att-file" href={`/api/files/${m.id}`} download={m.attachment.name}>
                    <span aria-hidden="true">📎</span>
                    <span className="att-name">{m.attachment.name}</span>
                    <span className="muted">{formatSize(m.attachment.size)}</span>
                  </a>
                ))}
              {firstLink && <LinkPreview url={firstLink} />}
              {reactions.length > 0 && (
                <div className="reactions" role="group" aria-label="Reações">
                  {reactions.map((r) => {
                    const mineR = !!user && r.users.includes(user.id);
                    return (
                      <button
                        key={r.emoji}
                        type="button"
                        className={`reaction${mineR ? " mine" : ""}`}
                        aria-pressed={mineR}
                        aria-label={`${r.emoji} ${r.count} ${r.count === 1 ? "reação" : "reações"}`}
                        onClick={() => void react(m.id, r.emoji)}
                      >
                        <span aria-hidden="true">{r.emoji}</span> {r.count}
                      </button>
                    );
                  })}
                </div>
              )}
              {pickerFor === m.id && (
                <div className="emoji-picker" role="group" aria-label="Escolher emoji">
                  {EMOJIS.map((e) => (
                    <button key={e} type="button" aria-label={`Reagir com ${e}`} onClick={() => void react(m.id, e)}>{e}</button>
                  ))}
                </div>
              )}
              {confirmingId === m.id && (
                <div className="confirm-row" role="group" aria-label="Confirmar exclusão">
                  <span>Apagar esta mensagem para todos?</span>
                  <button type="button" className="small danger" onClick={() => void remove(m.id)}>
                    Apagar
                  </button>
                  <button type="button" className="small secondary" onClick={() => setConfirmingId(null)}>
                    Cancelar
                  </button>
                </div>
              )}
            </li>
          );
        })}
        {loaded && !loadError && messages.length === 0 && !hasMore && (
          <li className="muted empty">
            {isDm ? `Esta é a sua conversa com ${title}. Diga oi!` : `Este é o começo de ${title}. Mande a primeira mensagem!`}
          </li>
        )}
      </ol>
      {loadError && <p role="alert" className="error chat-error">{loadError}</p>}
      {actionError && <p role="alert" className="error chat-error">{actionError}</p>}
      {sendError && <p role="alert" className="error chat-error">{sendError}</p>}
      <p className="typing" aria-live="polite">{typingText}</p>
      {replyingTo && (
        <div className="reply-bar">
          <span>
            Respondendo a <strong>{nameOf(replyingTo.author.id, replyingTo.author.username)}</strong>: {summary(replyingTo).slice(0, 80)}
          </span>
          <button type="button" className="small secondary" aria-label="Cancelar resposta" onClick={() => setReplyingTo(null)}>✕</button>
        </div>
      )}
      {pending && (
        <div className="pending-file">
          {pending.previewUrl ? <img src={pending.previewUrl} alt="" /> : <span aria-hidden="true">📎</span>}
          <span className="att-name">{pending.file.name || "arquivo"}</span>
          <span className="muted">{formatSize(pending.file.size)}</span>
          <button type="button" className="small secondary" aria-label="Remover anexo" onClick={() => setPending(null)}>✕</button>
        </div>
      )}
      {readOnly ? (
        <p className="muted read-only-note" role="note">🔒 Este canal é somente leitura: só quem gerencia os canais escreve aqui.</p>
      ) : (
      <>
      {suggestions(text, isDm).length > 0 && (
        <ul className="slash-list" role="listbox" aria-label="Comandos">
          {suggestions(text, isDm).map((c) => (
            <li key={c.name} role="option" aria-selected={false}>
              <button type="button" className="slash-item" onMouseDown={(e) => e.preventDefault()} onClick={() => setText(`/${c.name} `)}>
                <code>{c.usage}</code> <span className="muted">{c.help}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {mentionMatches.length > 0 && (
        <ul className="mention-list" role="listbox" aria-label="Mencionar alguém">
          {mentionMatches.map((m, i) => (
            <li key={m.id} role="option" aria-selected={m === mentionPick}>
              <button
                type="button"
                className={`mention-item${m === mentionPick ? " active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setMentionIdx(i)}
                onClick={() => pickMention(m.username)}
              >
                <Avatar id={m.id} username={m.username} size={24} />
                <span className="mention-name">{m.nickname || m.displayName || m.username}</span>
                <span className="muted mention-user">@{m.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {helpOpen && (
        <div className="slash-help" role="region" aria-label="Ajuda dos comandos">
          <strong>Comandos</strong>
          <ul>
            {COMMANDS.filter((c) => !(isDm && c.channelOnly)).map((c) => (
              <li key={c.name}><code>{c.usage}</code> <span className="muted">{c.help}</span></li>
            ))}
          </ul>
          <button type="button" className="small secondary" onClick={() => setHelpOpen(false)}>Fechar</button>
        </div>
      )}
      <form className="composer" onSubmit={onSubmit}>
        <input ref={fileRef} type="file" hidden aria-label="Escolher arquivo" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
        <button type="button" className="secondary icon-btn" aria-label="Anexar arquivo" title="Anexar imagem ou arquivo (até 8 MB)" onClick={() => fileRef.current?.click()}>
          📎
        </button>
        {!isDm && (
          <button type="button" className="secondary icon-btn" aria-label="Criar enquete" aria-expanded={pollOpen} title="Criar uma enquete" onClick={() => setPollOpen((v) => !v)}>
            📊
          </button>
        )}
        <input
          ref={inputRef}
          aria-label={isDm ? `Mensagem para ${title}` : `Mensagem em ${title}`}
          placeholder={isDm ? `Conversar com ${title}` : `Conversar em ${title}`}
          value={text}
          onChange={(e) => {
            onType(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setMentionIdx(0);
          }}
          onKeyDown={onComposerKeyDown}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? text.length)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? text.length)}
          onPaste={onPaste}
          maxLength={MAX_LENGTH}
          autoComplete="off"
        />
        <button
          type="button"
          className="secondary icon-btn"
          aria-label="Inserir emoji"
          aria-expanded={pickerFor === "composer"}
          onClick={() => setPickerFor(pickerFor === "composer" ? null : "composer")}
        >
          😊
        </button>
        <AudioRecorder onSend={sendAudio} />
        <button type="submit" disabled={sending || (text.trim() === "" && !pending)}>Enviar</button>
      </form>
      {pollOpen && !isDm && <PollForm onCreate={createPoll} onCancel={() => setPollOpen(false)} />}
      {!isDm && !!channel.slowmodeSeconds && (
        <p className="muted slowmode-note" role="note">🐢 Modo lento: uma mensagem a cada {formatSlowmode(channel.slowmodeSeconds)} (quem gerencia o canal não é limitado).</p>
      )}
      {pickerFor === "composer" && (
        <div className="emoji-picker composer-picker" role="group" aria-label="Escolher emoji">
          {EMOJIS.map((e) => (
            <button key={e} type="button" aria-label={`Inserir ${e}`} onClick={() => { setText((t) => (t + e).slice(0, MAX_LENGTH)); setPickerFor(null); }}>{e}</button>
          ))}
        </div>
      )}
      </>
      )}
      {lightbox && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Imagem ampliada" onClick={() => setLightbox(null)}>
          <img src={`/api/files/${lightbox.id}`} alt={lightbox.name} onClick={(e) => e.stopPropagation()} />
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <a href={`/api/files/${lightbox.id}`} target="_blank" rel="noopener noreferrer">Abrir original</a>
            <button type="button" className="small" onClick={() => setLightbox(null)}>Fechar</button>
          </div>
        </div>
      )}
    </div>
  );
}
