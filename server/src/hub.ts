import { WebSocket } from "ws";
import { audience } from "./channelAccess.js";
import type { Db } from "./db.js";
import { CallRooms } from "./calls.js";
import type { MediaPool } from "./mediaPool.js";
import type { PushService } from "./push.js";
import { VoiceRooms } from "./voice.js";

const DEFAULT_OFFLINE_GRACE_MS = 3000;

/**
 * Guarda as conexões WebSocket abertas por usuário, envia eventos aos membros de um servidor
 * e avisa quando alguém fica online/offline.
 */
export class Hub {
  private sockets = new Map<number, Set<WebSocket>>();
  /** Quem perdeu a última conexão e está na "carência" antes de ser anunciado como offline. */
  private pendingOffline = new Map<number, ReturnType<typeof setTimeout>>();

  /**
   * @param offlineGraceMs quanto esperar antes de anunciar offline. Evita piscar
   *   offline→online quando a pessoa só recarrega a página.
   */
  readonly voice: VoiceRooms;
  readonly calls: CallRooms;
  /** Notificação com o app fechado (ligada pelo createApp). */
  push: PushService | null = null;
  /** Escolha do servidor de mídia de cada sala (ligada pelo createApp); as salas avisam quando esvaziam. */
  media: MediaPool | null = null;

  constructor(
    private db: Db,
    private offlineGraceMs = DEFAULT_OFFLINE_GRACE_MS,
    ringMs?: number,
  ) {
    this.voice = new VoiceRooms(db, this);
    this.calls = new CallRooms(db, this, ringMs);
  }

  /** Versão atual do login da pessoa (null se a conta não existe). */
  tokenVersion(userId: number): number | null {
    const row = this.db.prepare("SELECT token_version FROM users WHERE id = ?").get(userId) as { token_version: number } | undefined;
    return row ? row.token_version : null;
  }

  /** Há alguma aba/aparelho com o app aberto agora (sem contar a carência de offline). */
  hasConnection(userId: number): boolean {
    return this.sockets.has(userId);
  }

  /** A conta foi excluída: fecha todas as conexões abertas da pessoa. */
  dropUser(userId: number) {
    const timer = this.pendingOffline.get(userId);
    if (timer) clearTimeout(timer);
    this.pendingOffline.delete(userId);
    for (const ws of this.sockets.get(userId) ?? []) ws.close(4001, "conta excluída");
    this.sockets.delete(userId);
  }

  /** Uma mensagem foi criada: avisa quem está com o app fechado. */
  notifyMessage(message: Parameters<PushService["onMessage"]>[0]) {
    this.push?.onMessage(message);
  }

  isOnline(userId: number): boolean {
    return this.sockets.has(userId) || this.pendingOffline.has(userId);
  }

  add(userId: number, ws: WebSocket) {
    const pending = this.pendingOffline.get(userId);
    if (pending) {
      // Voltou durante a carência: nunca chegou a ser anunciado como offline
      clearTimeout(pending);
      this.pendingOffline.delete(userId);
    }

    let set = this.sockets.get(userId);
    const cameOnline = !set && !pending;
    if (!set) this.sockets.set(userId, (set = new Set()));
    set.add(ws);
    if (cameOnline) this.publishPresence(userId, true);
  }

  remove(userId: number, ws: WebSocket) {
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size > 0) return; // ainda tem outra aba aberta

    this.sockets.delete(userId);
    if (this.offlineGraceMs <= 0) {
      this.publishPresence(userId, false);
      return;
    }
    const timer = setTimeout(() => {
      this.pendingOffline.delete(userId);
      this.publishPresence(userId, false);
    }, this.offlineGraceMs);
    timer.unref();
    this.pendingOffline.set(userId, timer);
  }

  private lastTyping = new Map<string, number>();

  /**
   * Alguém está digitando num canal ou conversa: confere se a pessoa pertence ao lugar e avisa os outros
   * (no máximo um aviso por segundo e meio por lugar, para não encher a conexão).
   */
  typing(userId: number, place: { channelId?: unknown; dmId?: unknown }) {
    const key = `${userId}:${place.channelId ?? "dm"}:${place.dmId ?? ""}`;
    const now = Date.now();
    if (now - (this.lastTyping.get(key) ?? 0) < 1500) return;
    if (this.lastTyping.size > 5000) for (const [k, at] of this.lastTyping) if (now - at > 10_000) this.lastTyping.delete(k);
    const user = this.db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string } | undefined;
    if (!user) return;
    if (Number.isInteger(place.channelId)) {
      const ch = this.db
        .prepare(
          `SELECT c.server_id FROM channels c JOIN members m ON m.server_id = c.server_id
           WHERE c.id = ? AND m.user_id = ? AND c.type = 'text'`,
        )
        .get(place.channelId as number, userId) as { server_id: number } | undefined;
      if (!ch || !audience(this.db, place.channelId as number).includes(userId)) return;
      this.lastTyping.set(key, now);
      this.publishToChannel(place.channelId as number, { type: "typing", userId, username: user.username, channelId: place.channelId }, userId);
    } else if (Number.isInteger(place.dmId)) {
      const dm = this.db
        .prepare("SELECT user_a, user_b FROM dm_conversations WHERE id = ? AND (user_a = ? OR user_b = ?)")
        .get(place.dmId as number, userId, userId) as { user_a: number; user_b: number } | undefined;
      if (!dm) return;
      this.lastTyping.set(key, now);
      this.publishToUsers([dm.user_a === userId ? dm.user_b : dm.user_a], { type: "typing", userId, username: user.username, dmId: place.dmId });
    }
  }

  /** Envia o evento a quem enxerga o canal (todos os membros, ou só quem tem acesso num canal privado). */
  publishToChannel(channelId: number, event: unknown, exceptUserId?: number) {
    this.sendTo(audience(this.db, channelId).filter((id) => id !== exceptUserId), event);
  }

  /** Envia o evento a todas as conexões abertas de quem é membro do servidor (menos `exceptUserId`, se dado). */
  publishToServer(serverId: number, event: unknown, exceptUserId?: number) {
    const members = this.db.prepare("SELECT user_id FROM members WHERE server_id = ?").all(serverId) as {
      user_id: number;
    }[];
    this.sendTo(
      members.map((m) => m.user_id).filter((id) => id !== exceptUserId),
      event,
    );
  }

  /** Envia o evento às conexões abertas das pessoas indicadas (ex.: os dois lados de uma DM). */
  publishToUsers(userIds: number[], event: unknown) {
    this.sendTo(userIds, event);
  }

  /** Envia o evento a quem divide algum servidor com a pessoa, e a ela mesma (todos os aparelhos). */
  publishToPeers(userId: number, event: unknown) {
    const peers = this.db
      .prepare(
        `SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m2.server_id = m1.server_id WHERE m1.user_id = ?`,
      )
      .all(userId) as { user_id: number }[];
    this.sendTo([userId, ...peers.map((p) => p.user_id)], event);
  }

  /** Avisa os outros que dividem algum servidor com o usuário (uma vez só por pessoa; ele mesmo não precisa). */
  private publishPresence(userId: number, online: boolean) {
    const peers = this.db
      .prepare(
        `SELECT DISTINCT m2.user_id FROM members m1
         JOIN members m2 ON m2.server_id = m1.server_id
         WHERE m1.user_id = ? AND m2.user_id != m1.user_id`,
      )
      .all(userId) as { user_id: number }[];
    this.sendTo(
      peers.map((p) => p.user_id),
      { type: "presence.updated", userId, online },
    );
  }

  private sendTo(userIds: number[], event: unknown) {
    const payload = JSON.stringify(event);
    for (const id of userIds) {
      for (const ws of this.sockets.get(id) ?? []) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    }
  }
}
