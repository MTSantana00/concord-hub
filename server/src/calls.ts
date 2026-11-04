import type { WebSocket } from "ws";
import type { Db } from "./db.js";
import type { Hub } from "./hub.js";
import { callRoomName } from "./mediaPool.js";

export const RING_MS = 30_000;

type EndReason = "declined" | "cancelled" | "missed" | "hangup" | "disconnected";

interface Call {
  dmId: number;
  callerId: number;
  calleeId: number;
  state: "ringing" | "active";
  /** A conexão de cada lado que está na chamada (quem fecha a aba derruba a chamada). */
  callerWs: WebSocket;
  calleeWs?: WebSocket;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Chamadas de voz/vídeo/tela numa conversa direta: toca (30 s), a outra pessoa atende ou recusa, e vira uma sala
 * privada de duas pessoas. Só existe na memória. Cada pessoa participa de uma chamada por vez; uma chamada
 * acaba quando qualquer lado desliga, recusa, ninguém atende ou a conexão cai.
 */
export class CallRooms {
  private calls = new Map<number, Call>();
  /** Em qual conversa cada pessoa está chamando, sendo chamada ou falando. */
  private byUser = new Map<number, number>();

  constructor(
    private db: Db,
    private hub: Hub,
    private ringMs = RING_MS,
  ) {}

  private user(id: number) {
    return this.db.prepare("SELECT id, username FROM users WHERE id = ?").get(id) as { id: number; username: string };
  }

  /** Quem chama liga para a outra pessoa da conversa. Devolve a mensagem de erro, ou null. */
  start(userId: number, ws: WebSocket, dmId: unknown): string | null {
    if (!Number.isInteger(dmId)) return "Conversa inválida";
    const dm = this.db
      .prepare("SELECT user_a, user_b FROM dm_conversations WHERE id = ? AND (user_a = ? OR user_b = ?)")
      .get(dmId as number, userId, userId) as { user_a: number; user_b: number } | undefined;
    if (!dm) return "Conversa não encontrada";

    const calleeId = dm.user_a === userId ? dm.user_b : dm.user_a;
    if (this.byUser.has(userId)) return "Você já está em uma chamada";
    if (this.byUser.has(calleeId)) return "A pessoa está ocupada em outra chamada";
    // offline, mas com o celular/PC assinado nas notificações: dá para tocar por notificação (e abrir já com a chamada)
    if (!this.hub.isOnline(calleeId) && !this.hub.push?.canNotifyCall(calleeId)) return "A pessoa está offline";

    this.hub.voice.leave(userId);
    const call: Call = { dmId: dmId as number, callerId: userId, calleeId, state: "ringing", callerWs: ws };
    call.timer = setTimeout(() => this.end(call, "missed"), this.ringMs);
    call.timer.unref();
    this.calls.set(call.dmId, call);
    this.byUser.set(userId, call.dmId);
    this.byUser.set(calleeId, call.dmId);
    this.hub.publishToUsers([userId, calleeId], {
      type: "call.ringing",
      dmId: call.dmId,
      from: this.user(userId),
      to: this.user(calleeId),
    });
    if (!this.hub.hasConnection(calleeId)) this.hub.push?.notifyCall(calleeId, this.user(userId).username, call.dmId);
    return null;
  }

  /** Alguém abriu o app (ex.: tocando na notificação da ligação): se uma chamada para essa pessoa ainda está tocando, mostra para ela. */
  onConnect(userId: number, ws: WebSocket) {
    const dmId = this.byUser.get(userId);
    const call = dmId === undefined ? undefined : this.calls.get(dmId);
    if (!call || call.state !== "ringing" || call.calleeId !== userId || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "call.ringing", dmId: call.dmId, from: this.user(call.callerId), to: this.user(call.calleeId) }));
  }

  accept(userId: number, ws: WebSocket, dmId: unknown): string | null {
    const call = this.calls.get(dmId as number);
    if (!call || call.state !== "ringing" || call.calleeId !== userId) return "Nenhuma chamada para atender";
    clearTimeout(call.timer);
    this.hub.voice.leave(userId);
    call.state = "active";
    call.calleeWs = ws;
    this.hub.publishToUsers([call.callerId, call.calleeId], { type: "call.accepted", dmId: call.dmId });
    return null;
  }

  decline(userId: number, dmId: unknown): string | null {
    const call = this.calls.get(dmId as number);
    if (!call || call.state !== "ringing" || call.calleeId !== userId) return "Nenhuma chamada para recusar";
    this.end(call, "declined");
    return null;
  }

  /** Desliga (ou cancela, se ainda estiver tocando). */
  hangup(userId: number, dmId: unknown): string | null {
    const call = this.calls.get(dmId as number);
    if (!call || (call.callerId !== userId && call.calleeId !== userId)) return "Nenhuma chamada para desligar";
    this.end(call, call.state === "ringing" ? "cancelled" : "hangup");
    return null;
  }

  /** A pessoa foi para outro lugar (ex.: entrou numa sala de voz): sai da chamada em que estiver. */
  hangupFor(userId: number) {
    const dmId = this.byUser.get(userId);
    const call = dmId === undefined ? undefined : this.calls.get(dmId);
    if (call) this.end(call, call.state === "ringing" ? "cancelled" : "hangup");
  }

  socketClosed(userId: number, ws: WebSocket) {
    const dmId = this.byUser.get(userId);
    const call = dmId === undefined ? undefined : this.calls.get(dmId);
    if (call && (call.callerWs === ws || call.calleeWs === ws)) this.end(call, "disconnected");
  }

  /** A chamada em andamento (já atendida) em que a pessoa está, se houver. */
  /** Uma entrada por chamada atendida, com o número de pessoas nela (para contar o uso do plano de voz). */
  activeCallSizes(): { room: string; size: number }[] {
    return [...this.calls.values()].filter((c) => c.state === "active").map((c) => ({ room: callRoomName(c.dmId), size: 2 }));
  }

  activeFor(userId: number): { dmId: number } | undefined {
    const dmId = this.byUser.get(userId);
    const call = dmId === undefined ? undefined : this.calls.get(dmId);
    return call?.state === "active" ? { dmId: call.dmId } : undefined;
  }

  private end(call: Call, reason: EndReason) {
    clearTimeout(call.timer);
    this.calls.delete(call.dmId);
    this.byUser.delete(call.callerId);
    this.byUser.delete(call.calleeId);
    this.hub.media?.left(callRoomName(call.dmId), call.callerId);
    this.hub.media?.left(callRoomName(call.dmId), call.calleeId);
    this.hub.publishToUsers([call.callerId, call.calleeId], { type: "call.ended", dmId: call.dmId, reason });
  }
}
