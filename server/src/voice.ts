import type { WebSocket } from "ws";
import type { Db } from "./db.js";
import { audience, canSeeChannel } from "./channelAccess.js";
import type { Hub } from "./hub.js";
import { roomName } from "./mediaPool.js";

interface Seat {
  channelId: number;
  serverId: number;
  /** A conexão que entrou; se ela cair, a pessoa sai da sala (outras abas não seguram a vaga). */
  ws: WebSocket;
}

export interface Participant {
  channelId: number;
  userId: number;
  username: string;
}

/**
 * Quem está em cada sala de voz. Vive só na memória: se o servidor reinicia, todos saem
 * (as conexões também caem). Uma pessoa ocupa no máximo uma sala por vez.
 */
export class VoiceRooms {
  private seats = new Map<number, Seat>();

  constructor(
    private db: Db,
    private hub: Hub,
  ) {}

  /** Entra na sala. Devolve a mensagem de erro, ou null se deu certo. */
  join(userId: number, ws: WebSocket, channelId: unknown): string | null {
    if (!Number.isInteger(channelId)) return "Canal inválido";
    const channel = this.db
      .prepare(
        `SELECT c.id, c.server_id, s.owner_id, c.private FROM channels c
         JOIN servers s ON s.id = c.server_id
         JOIN members m ON m.server_id = c.server_id
         WHERE c.id = ? AND c.type = 'voice' AND m.user_id = ?`,
      )
      .get(channelId as number, userId) as { id: number; server_id: number; owner_id: number; private: number } | undefined;
    if (!channel || !canSeeChannel(this.db, channel, userId)) return "Canal de voz não encontrado";

    this.hub.calls.hangupFor(userId); // sala de voz e chamada na DM não ao mesmo tempo
    const current = this.seats.get(userId);
    if (current?.channelId === channel.id) {
      // mesma sala, outro aparelho ou aba: a vaga passa para a conexão nova, sem avisar a sala;
      // só o aparelho antigo é avisado, para largar a ligação em vez de brigar pela mesma voz
      const old = current.ws;
      current.ws = ws;
      if (old !== ws && old.readyState === old.OPEN) old.send(JSON.stringify({ type: "voice.moved", channelId: channel.id }));
      return null;
    }
    if (current) this.leave(userId);

    this.seats.set(userId, { channelId: channel.id, serverId: channel.server_id, ws });
    const user = this.db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string };
    this.hub.publishToChannel(channel.id, {
      type: "voice.joined",
      serverId: channel.server_id,
      channelId: channel.id,
      user: { id: userId, username: user.username },
    });
    return null;
  }

  leave(userId: number) {
    const seat = this.seats.get(userId);
    if (!seat) return;
    this.seats.delete(userId);
    this.hub.media?.left(roomName(seat.channelId), userId);
    this.hub.publishToChannel(seat.channelId, {
      type: "voice.left",
      serverId: seat.serverId,
      channelId: seat.channelId,
      userId,
    });
  }

  /** Tira a pessoa da sala (expulsão por quem modera). Avisa só ela, depois todos; devolve a sala de onde saiu. */
  kick(userId: number, byUserId: number): { channelId: number; serverId: number } | undefined {
    const seat = this.seats.get(userId);
    if (!seat) return undefined;
    this.hub.publishToUsers([userId], { type: "voice.kicked", serverId: seat.serverId, channelId: seat.channelId, byUserId });
    this.leave(userId);
    return { channelId: seat.channelId, serverId: seat.serverId };
  }

  /** O canal vai ser apagado: todos que estão nele saem da sala. */
  closeChannel(channelId: number) {
    for (const [userId, seat] of [...this.seats]) if (seat.channelId === channelId) this.leave(userId);
  }

  /** A pessoa saiu (ou foi tirada) do servidor: se estava numa sala dele, sai da sala. */
  removeFromServer(userId: number, serverId: number) {
    if (this.seats.get(userId)?.serverId === serverId) this.leave(userId);
  }

  /** A conexão caiu: se era ela que segurava a vaga, a pessoa sai da sala. */
  socketClosed(userId: number, ws: WebSocket) {
    if (this.seats.get(userId)?.ws === ws) this.leave(userId);
  }

  /** Quantas pessoas há em cada sala agora (para contar o uso do plano de voz). */
  roomSizes(): { room: string; size: number }[] {
    const counts = new Map<number, number>();
    for (const seat of this.seats.values()) counts.set(seat.channelId, (counts.get(seat.channelId) ?? 0) + 1);
    return [...counts].map(([channelId, size]) => ({ room: roomName(channelId), size }));
  }

  /** Em que sala a pessoa está agora (undefined se em nenhuma). */
  seatOf(userId: number): { channelId: number; serverId: number } | undefined {
    const seat = this.seats.get(userId);
    return seat && { channelId: seat.channelId, serverId: seat.serverId };
  }

  /** Quem está em cada sala de voz de um servidor. */
  participants(serverId: number, viewerId?: number): Participant[] {
    const result: Participant[] = [];
    for (const [userId, seat] of this.seats) {
      if (seat.serverId !== serverId) continue;
      if (viewerId !== undefined && !audience(this.db, seat.channelId).includes(viewerId)) continue;
      const u = this.db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string };
      result.push({ channelId: seat.channelId, userId, username: u.username });
    }
    return result;
  }
}
