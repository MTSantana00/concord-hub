import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { useAuth } from "./AuthContext";
import { getNotifyPrefs } from "./notifyPrefs";
import { nameOf, useProfiles } from "./profiles";
import { playSound } from "./sounds";
import { useSocket, type Message } from "./socket";

export const UNREAD_CAP = 99;

export interface PlaceCount {
  unread: number;
  mentions: number;
}
export type Place = { kind: "channel" | "dm"; id: number };
export type MuteKind = "channel" | "server" | "dm";

interface Snapshot {
  channels: Record<number, PlaceCount>;
  dms: Record<number, PlaceCount>;
  mutes: { channels: number[]; servers: number[]; dms: number[] };
}

interface NotifyState {
  count: (kind: "channel" | "dm", id: number) => PlaceCount;
  isMuted: (kind: MuteKind, id: number) => boolean;
  toggleMute: (kind: MuteKind, id: number) => void;
  /** O que está aberto na tela (para não avisar do que a pessoa já está vendo). */
  setActive: (place: Place | null) => void;
}

const NONE: PlaceCount = { unread: 0, mentions: 0 };
const NotifyContext = createContext<NotifyState | null>(null);

/** `@usuario` como palavra inteira, sem diferenciar maiúsculas (mesma regra do servidor). */
export function mentionsUser(content: string, username: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@])@${escaped}(?![\\w])`, "i").test(content);
}

const windowFocused = () => document.visibilityState !== "hidden" && (typeof document.hasFocus !== "function" || document.hasFocus());

function placeOf(m: Message): Place | null {
  if (m.dmId != null) return { kind: "dm", id: m.dmId };
  if (m.channelId != null) return { kind: "channel", id: m.channelId };
  return null;
}

const key = (kind: string, id: number) => `${kind}:${id}`;

export function NotifyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { epoch, subscribe } = useSocket();
  const { get } = useProfiles();
  const [counts, setCounts] = useState<Record<string, PlaceCount>>({});
  const [mutes, setMutes] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState(windowFocused);
  const active = useRef<Place | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const mutesRef = useRef(mutes);
  mutesRef.current = mutes;
  const getRef = useRef(get);
  getRef.current = get;
  const userRef = useRef(user);
  userRef.current = user;

  // Foto do que não li: ao entrar e a cada reconexão
  useEffect(() => {
    let cancelled = false;
    api<Snapshot>("/api/unread")
      .then((s) => {
        if (cancelled) return;
        const next: Record<string, PlaceCount> = {};
        for (const [id, c] of Object.entries(s.channels)) next[key("channel", Number(id))] = c;
        for (const [id, c] of Object.entries(s.dms)) next[key("dm", Number(id))] = c;
        setCounts(next);
        setMutes(new Set([...s.mutes.channels.map((i) => key("channel", i)), ...s.mutes.servers.map((i) => key("server", i)), ...s.mutes.dms.map((i) => key("dm", i))]));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [epoch]);

  useEffect(() => {
    const update = () => setFocused(windowFocused());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const markRead = useCallback((place: Place) => {
    setCounts((prev) => (prev[key(place.kind, place.id)]?.unread ? { ...prev, [key(place.kind, place.id)]: NONE } : prev));
    api<void>(`/api/${place.kind === "dm" ? "dms" : "channels"}/${place.id}/read`, "PUT").catch(() => {});
  }, []);

  // O lugar aberto, com a janela à vista, é lido na hora; tudo o que chegar depois também
  const openCount = activeKey ? counts[activeKey]?.unread ?? 0 : 0;
  useEffect(() => {
    if (focused && active.current && openCount > 0) markRead(active.current);
  }, [focused, activeKey, openCount, markRead]);

  const setActive = useCallback((place: Place | null) => {
    active.current = place;
    setActiveKey(place ? key(place.kind, place.id) : null);
  }, []);

  const muted = useCallback((m: Message, place: Place) => {
    const set = mutesRef.current;
    return set.has(key(place.kind, place.id)) || (m.serverId != null && set.has(key("server", m.serverId)));
  }, []);

  useEffect(
    () =>
      subscribe((event) => {
        const me = userRef.current;
        if (event.type === "message.created" && me) {
          const m = event.message;
          const place = placeOf(m);
          if (!place || m.author.id === me.id) return;
          const seen = focusedNow() && active.current?.kind === place.kind && active.current.id === place.id;
          if (seen) {
            markRead(place);
            return;
          }
          const mention = place.kind === "dm" || mentionsUser(m.content, me.username);
          setCounts((prev) => {
            const cur = prev[key(place.kind, place.id)] ?? NONE;
            return {
              ...prev,
              [key(place.kind, place.id)]: { unread: Math.min(cur.unread + 1, UNREAD_CAP + 1), mentions: cur.mentions + (mention ? 1 : 0) },
            };
          });
          const prefs = getNotifyPrefs();
          const silent = muted(m, place) || me.statusKind === "dnd";
          if (silent) return;
          if (prefs.sounds) playSound(mention ? "mention" : "message", prefs.volume);
          if (prefs.desktop && !focusedNow() && typeof Notification !== "undefined" && Notification.permission === "granted") {
            const who = nameOf(getRef.current(m.author.id), m.author.username);
            const body = m.content || (m.audio ? "enviou uma mensagem de voz" : m.attachment ? "enviou um arquivo" : "");
            try {
              const n = new Notification(who, { body, tag: key(place.kind, place.id) });
              n.onclick = () => {
                window.focus();
                n.close();
              };
            } catch {
              // navegador sem suporte a construir notificação: só o som
            }
          }
        } else if (event.type === "admin.alert") {
          const prefs = getNotifyPrefs();
          if (prefs.sounds) playSound("mention", prefs.volume);
          if (prefs.desktop && !focusedNow() && typeof Notification !== "undefined" && Notification.permission === "granted") {
            try {
              new Notification(`⚠ ${event.alert.title}`, { body: event.alert.message, tag: "admin-alert" });
            } catch {
              // sem suporte: só o som e o aviso na tela
            }
          }
        } else if (event.type === "read.updated") {
          setCounts((prev) => ({ ...prev, [key(event.kind, event.id)]: NONE }));
        } else if (event.type === "mute.updated") {
          setMutes((prev) => {
            const next = new Set(prev);
            if (event.muted) next.add(key(event.kind, event.id));
            else next.delete(key(event.kind, event.id));
            return next;
          });
        }
      }),
    [subscribe, markRead, muted],
  );

  const toggleMute = useCallback((kind: MuteKind, id: number) => {
    const was = mutesRef.current.has(key(kind, id));
    setMutes((prev) => {
      const next = new Set(prev);
      if (was) next.delete(key(kind, id));
      else next.add(key(kind, id));
      return next;
    });
    api<void>(`/api/mutes/${kind}/${id}`, was ? "DELETE" : "PUT").catch(() => {});
  }, []);

  // Título da aba: quantas não lidas (de lugares não silenciados)
  useEffect(() => {
    let total = 0;
    for (const [k, c] of Object.entries(counts)) if (!mutes.has(k)) total += c.unread;
    document.title = total > 0 ? `(${total > UNREAD_CAP ? `${UNREAD_CAP}+` : total}) Concord Hub` : "Concord Hub";
  }, [counts, mutes]);

  const value = useMemo<NotifyState>(
    () => ({
      count: (kind, id) => counts[key(kind, id)] ?? NONE,
      isMuted: (kind, id) => mutes.has(key(kind, id)),
      toggleMute,
      setActive,
    }),
    [counts, mutes, toggleMute, setActive],
  );
  return <NotifyContext.Provider value={value}>{children}</NotifyContext.Provider>;
}

function focusedNow() {
  return windowFocused();
}

export function useNotify(): NotifyState {
  const ctx = useContext(NotifyContext);
  if (!ctx) throw new Error("useNotify precisa estar dentro de <NotifyProvider>");
  return ctx;
}

/** Marcador de não lidas: vermelho com o número se há menção, branco com o número se não, discreto se silenciado. */
export function Badge({ count, muted = false }: { count: PlaceCount; muted?: boolean }) {
  if (count.unread === 0) return null;
  const shown = count.unread > UNREAD_CAP ? `${UNREAD_CAP}+` : String(count.unread);
  if (count.mentions > 0) {
    return (
      <span className="unread-badge mention" role="img" aria-label={`${count.mentions} ${count.mentions === 1 ? "menção" : "menções"}`}>
        {count.mentions}
      </span>
    );
  }
  return (
    <span className={`unread-badge${muted ? " muted" : ""}`} role="img" aria-label={`${shown} não lidas`}>
      {muted ? "" : shown}
    </span>
  );
}
