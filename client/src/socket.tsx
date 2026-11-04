import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Poll } from "./Poll";

export interface Message {
  id: number;
  /** Mensagem de canal: channelId e serverId; mensagem direta: dmId (os outros ficam null). */
  channelId: number | null;
  dmId: number | null;
  serverId: number | null;
  content: string;
  createdAt: string;
  /** Quando foi editada (null se nunca foi). */
  editedAt: string | null;
  /** Mensagem de áudio (content vem vazio); o arquivo está em /api/audio/<id>. */
  audio?: { durationMs: number; mime: string } | null;
  /** Arquivo anexado (imagem aparece na conversa; outros viram cartão para baixar); o arquivo está em /api/files/<id>. */
  attachment?: { name: string; mime: string; size: number; kind: "image" | "file" } | null;
  /** Mensagem respondida (snippet vazio e deleted=true se foi apagada). */
  replyTo?: { id: number; deleted: boolean; author: { id: number; username: string; displayName?: string | null } | null; snippet: string } | null;
  pinned?: boolean;
  reactions?: Reaction[];
  /** Enquete (a pergunta é o content); null/ausente se for mensagem comum. */
  poll?: Poll | null;
  author: { id: number; username: string; displayName?: string | null; about?: string; statusKind?: string; statusText?: string; avatarVersion?: number };
}

/** Aviso de limite para a administradora (voz perto de acabar, VM sem memória...). */
export interface AdminAlert {
  id: number;
  level: "aviso" | "critico";
  title: string;
  message: string;
  createdAt: string;
  acked: boolean;
}

export interface Reaction {
  emoji: string;
  count: number;
  users: number[];
}

export interface Member {
  id: number;
  username: string;
  online: boolean;
  isOwner: boolean;
  /** Cargo no servidor (o dono não tem). */
  roleId?: number | null;
  roleName?: string | null;
  displayName?: string | null;
  about?: string;
  statusKind?: string;
  statusText?: string;
  avatarVersion?: number;
  /** Apelido neste servidor. */
  nickname?: string | null;
  /** Fim do timeout, em ms desde 1970 (null/ausente = pode falar). */
  timeoutUntil?: number | null;
}

export type ServerEvent =
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
  | { type: "message.deleted"; id: number; channelId: number | null; dmId: number | null; serverId: number | null }
  | { type: "message.reactions"; messageId: number; channelId?: number; dmId?: number; serverId: number | null; reactions: Reaction[] }
  | { type: "read.updated"; kind: "channel" | "dm"; id: number }
  | { type: "mute.updated"; kind: "channel" | "server" | "dm"; id: number; muted: boolean }
  | { type: "voice.kicked"; serverId: number; channelId: number; byUserId: number }
  | { type: "channels.changed"; serverId: number }
  | { type: "member.updated"; serverId: number; userId: number; nickname: string | null }
  | { type: "member.timeout"; serverId: number; userId: number; timeoutUntil: number | null }
  | { type: "admin.alert"; alert: AdminAlert }
  | { type: "typing"; userId: number; username: string; channelId?: number; dmId?: number }
  | { type: "presence.updated"; userId: number; online: boolean }
  | { type: "member.joined"; serverId: number; member: Member }
  | { type: "voice.joined"; serverId: number; channelId: number; user: { id: number; username: string } }
  | { type: "voice.left"; serverId: number; channelId: number; userId: number }
  | { type: "voice.moved"; channelId: number }
  | { type: "call.ringing"; dmId: number; from: { id: number; username: string }; to: { id: number; username: string } }
  | { type: "call.accepted"; dmId: number }
  | { type: "call.ended"; dmId: number; reason: string }
  | { type: "roles.changed"; serverId: number }
  | { type: "profile.updated"; userId: number; profile: { displayName: string | null; about: string; statusKind: string; statusText: string; avatarVersion: number } }
  | { type: "server.updated"; serverId: number; name: string; iconVersion: number }
  | { type: "member.removed"; serverId: number; userId: number; reason: "kicked" | "banned" | "left" }
  | { type: "error"; error: string };
type Listener = (event: ServerEvent) => void;

interface SocketState {
  /** Sobe a cada reconexão: quem depende dele deve recarregar o que pode ter perdido. */
  epoch: number;
  subscribe: (listener: Listener) => () => void;
  /** Manda uma mensagem ao servidor; false se a conexão não está aberta. */
  send: (data: unknown) => boolean;
}

const SocketContext = createContext<SocketState | null>(null);

const MAX_DELAY_MS = 10_000;

export function SocketProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const socket = useRef<WebSocket | null>(null);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let stopped = false;
    let reconnecting = false;

    function connect() {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      socket.current = ws;
      ws.onopen = () => {
        attempts = 0;
        if (reconnecting) setEpoch((e) => e + 1);
      };
      ws.onmessage = (ev) => {
        let event: ServerEvent;
        try {
          event = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        for (const l of listeners.current) l(event);
      };
      ws.onclose = () => {
        if (stopped) return;
        reconnecting = true;
        timer = setTimeout(connect, Math.min(1000 * 2 ** attempts++, MAX_DELAY_MS));
      };
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const send = useCallback((data: unknown) => {
    const ws = socket.current;
    if (!ws || ws.readyState !== 1) return false; // 1 = OPEN
    ws.send(JSON.stringify(data));
    return true;
  }, []);

  const value = useMemo(() => ({ epoch, subscribe, send }), [epoch, subscribe, send]);
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketState {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error("useSocket precisa estar dentro de <SocketProvider>");
  return ctx;
}
