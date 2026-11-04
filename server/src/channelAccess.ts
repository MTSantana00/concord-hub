import type { Db } from "./db.js";
import { can } from "./roles.js";

export interface ChannelRow {
  id: number;
  server_id: number;
  owner_id: number;
  type: string;
  read_only: number;
  private: number;
}

export function channelRow(db: Db, channelId: number): ChannelRow | undefined {
  if (!Number.isInteger(channelId)) return undefined;
  return db
    .prepare(
      `SELECT c.id, c.server_id, s.owner_id, c.type, c.read_only, c.private FROM channels c
       JOIN servers s ON s.id = c.server_id WHERE c.id = ?`,
    )
    .get(channelId) as ChannelRow | undefined;
}

/**
 * Quem enxerga o canal (a pessoa já é membro do servidor): todos, se o canal é público; num canal privado,
 * o dono, quem tem "gerenciar canais" e quem tem um dos cargos liberados para ele.
 */
export function canSeeChannel(db: Db, ch: Pick<ChannelRow, "id" | "server_id" | "owner_id" | "private">, userId: number): boolean {
  if (!ch.private || ch.owner_id === userId) return true;
  const byRole = db
    .prepare(
      `SELECT 1 FROM channel_roles cr JOIN members m ON m.role_id = cr.role_id
       WHERE cr.channel_id = ? AND m.user_id = ? AND m.server_id = ?`,
    )
    .get(ch.id, userId, ch.server_id);
  return !!byRole || can(db, ch.server_id, userId, "manage_channels");
}

/** Canal somente leitura: só o dono e quem gerencia canais escrevem nele. */
export function canPostInChannel(db: Db, ch: Pick<ChannelRow, "server_id" | "owner_id" | "read_only">, userId: number): boolean {
  return !ch.read_only || ch.owner_id === userId || can(db, ch.server_id, userId, "manage_channels");
}

export const MAX_SLOWMODE = 21600; // 6 horas

/**
 * Modo lento: segundos que a pessoa ainda precisa esperar para mandar outra mensagem neste canal (0 = pode mandar).
 * O dono e quem gerencia canais ou modera mensagens não são limitados.
 */
export function slowmodeWait(db: Db, ch: Pick<ChannelRow, "id" | "server_id" | "owner_id">, userId: number, now = Date.now()): number {
  const row = db.prepare("SELECT slowmode_seconds AS s FROM channels WHERE id = ?").get(ch.id) as { s: number } | undefined;
  if (!row || row.s <= 0) return 0;
  if (ch.owner_id === userId || can(db, ch.server_id, userId, "manage_channels") || can(db, ch.server_id, userId, "manage_messages")) return 0;
  const last = db.prepare("SELECT MAX(created_at) AS t FROM messages WHERE channel_id = ? AND user_id = ?").get(ch.id, userId) as { t: string | null };
  if (!last.t) return 0;
  const left = row.s - (now - Date.parse(last.t)) / 1000;
  return left > 0 ? Math.ceil(left) : 0;
}

export const MAX_TIMEOUT_MINUTES = 40320; // 28 dias, como no Discord

/** Segundos que faltam para acabar o timeout da pessoa neste servidor (0 = sem timeout). */
export function timeoutLeft(db: Db, serverId: number, userId: number, now = Date.now()): number {
  const row = db.prepare("SELECT timeout_until AS t FROM members WHERE server_id = ? AND user_id = ?").get(serverId, userId) as { t: number | null } | undefined;
  if (!row?.t || row.t <= now) return 0;
  return Math.ceil((row.t - now) / 1000);
}

export interface SendBlock {
  status: number;
  error: string;
  retryAfter: number;
}

function humanWait(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const min = Math.ceil(seconds / 60);
  if (min < 90) return `${min} min`;
  const h = Math.ceil(min / 60);
  return h < 48 ? `${h} h` : `${Math.ceil(h / 24)} dias`;
}

/** O que impede a pessoa de enviar agora neste canal: timeout (403) ou modo lento (429); null se pode enviar. */
export function sendBlock(db: Db, ch: Pick<ChannelRow, "id" | "server_id" | "owner_id">, userId: number): SendBlock | null {
  const left = timeoutLeft(db, ch.server_id, userId);
  if (left > 0) return { status: 403, error: `Você está em timeout: volta a falar em ${humanWait(left)}`, retryAfter: left };
  const wait = slowmodeWait(db, ch, userId);
  if (wait > 0) return { status: 429, error: `Modo lento: espere ${wait} s para enviar de novo`, retryAfter: wait };
  return null;
}

/** Os membros que enxergam o canal (para onde vão os eventos dele). */
export function audience(db: Db, channelId: number): number[] {
  const ch = channelRow(db, channelId);
  if (!ch) return [];
  const members = db.prepare("SELECT user_id FROM members WHERE server_id = ?").all(ch.server_id) as { user_id: number }[];
  return members.map((m) => m.user_id).filter((id) => canSeeChannel(db, ch, id));
}
