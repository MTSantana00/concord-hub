import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { COOKIE_NAME, userIdFromToken, type AuthConfig } from "./auth.js";
import type { Hub } from "./hub.js";

const PING_MS = 30_000;

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function reject(socket: Duplex, status: string) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Mensagens que o cliente manda: voice.join {channelId}, voice.leave, call.start/accept/decline/hangup {dmId}.
 * Qualquer outra coisa (binário, JSON inválido, tipo desconhecido) recebe um aviso de erro; a conexão segue.
 */
function handleClientMessage(hub: Hub, userId: number, ws: WebSocket, raw: unknown, isBinary: boolean) {
  const fail = (error: string) => ws.send(JSON.stringify({ type: "error", error }));
  let msg: unknown;
  try {
    if (isBinary) throw new Error("binário");
    msg = JSON.parse(String(raw));
  } catch {
    return fail("Mensagem inválida");
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return fail("Mensagem inválida");
  const m = msg as { type?: unknown; channelId?: unknown; dmId?: unknown };

  if (m.type === "voice.join") {
    const error = hub.voice.join(userId, ws, m.channelId);
    if (error) fail(error);
  } else if (m.type === "voice.leave") {
    hub.voice.leave(userId);
  } else if (m.type === "typing") {
    hub.typing(userId, m as { channelId?: unknown; dmId?: unknown });
  } else if (m.type === "call.start") {
    const error = hub.calls.start(userId, ws, m.dmId);
    if (error) fail(error);
  } else if (m.type === "call.accept") {
    const error = hub.calls.accept(userId, ws, m.dmId);
    if (error) fail(error);
  } else if (m.type === "call.decline") {
    const error = hub.calls.decline(userId, m.dmId);
    if (error) fail(error);
  } else if (m.type === "call.hangup") {
    const error = hub.calls.hangup(userId, m.dmId);
    if (error) fail(error);
  } else {
    fail("Tipo de mensagem desconhecido");
  }
}

/** O host de um cabeçalho Origin; null se ele não for um endereço válido (nunca lança). */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** Aceita WebSocket em /ws, autenticado pelo mesmo cookie de sessão do REST. */
export function attachRealtime(server: Server, hub: Hub, baseCfg: AuthConfig) {
  const cfg: AuthConfig = { ...baseCfg, tokenVersion: (id) => hub.tokenVersion(id) };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }

    // Só aceita páginas servidas pelo próprio host (evita sites de fora abrindo o socket)
    const origin = req.headers.origin;
    if (origin && originHost(origin) !== req.headers.host) {
      reject(socket, "403 Forbidden");
      return;
    }

    const userId = userIdFromToken(cfg, readCookie(req.headers.cookie, COOKIE_NAME));
    if (userId === null) {
      reject(socket, "401 Unauthorized");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      hub.add(userId, ws);
      hub.calls.onConnect(userId, ws);
      ws.on("pong", () => alive.set(ws, true));
      ws.on("close", () => {
        hub.voice.socketClosed(userId, ws);
        hub.calls.socketClosed(userId, ws);
        hub.remove(userId, ws);
      });
      ws.on("error", () => ws.terminate());
      ws.on("message", (raw, isBinary) => handleClientMessage(hub, userId, ws, raw, isBinary));
    });
  });

  // Derruba conexões que sumiram sem avisar (rede caiu, aba morreu)
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, PING_MS);
  timer.unref();

  server.on("close", () => {
    clearInterval(timer);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });
}
