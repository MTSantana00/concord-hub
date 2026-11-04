import { canSeeChannel } from "./channelAccess.js";
import type { Db } from "./db.js";

export const UNREAD_CAP = 99;
export type PlaceKind = "channel" | "dm";
export type MuteKind = "channel" | "server" | "dm";

export interface PlaceCount {
  unread: number;
  mentions: number;
}

export interface Snapshot {
  channels: Record<number, PlaceCount>;
  dms: Record<number, PlaceCount>;
  mutes: { channels: number[]; servers: number[]; dms: number[] };
}

/** `@usuario` como palavra inteira (`@ana` não casa `@anabel`), sem diferenciar maiúsculas. */
export function mentionsUser(content: string, username: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@])@${escaped}(?![\\w])`, "i").test(content);
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, "\\$&");

function lastRead(db: Db, userId: number, kind: PlaceKind, targetId: number): number {
  const row = db.prepare("SELECT last_read_id FROM read_state WHERE user_id = ? AND kind = ? AND target_id = ?").get(userId, kind, targetId) as
    | { last_read_id: number }
    | undefined;
  if (row) return row.last_read_id;
  // Primeira vez que o lugar aparece: o que já existe conta como lido
  const col = kind === "channel" ? "channel_id" : "dm_id";
  const max = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE ${col} = ?`).get(targetId) as { m: number }).m;
  db.prepare("INSERT OR IGNORE INTO read_state (user_id, kind, target_id, last_read_id) VALUES (?, ?, ?, ?)").run(userId, kind, targetId, max);
  return max;
}

function count(db: Db, userId: number, username: string, kind: PlaceKind, targetId: number): PlaceCount {
  const col = kind === "channel" ? "channel_id" : "dm_id";
  const after = lastRead(db, userId, kind, targetId);
  const unread = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages WHERE ${col} = ? AND id > ? AND user_id != ? LIMIT ${UNREAD_CAP + 1})`)
      .get(targetId, after, userId) as { n: number }
  ).n;
  if (unread === 0) return { unread: 0, mentions: 0 };
  if (kind === "dm") return { unread, mentions: unread }; // em conversa direta tudo é para mim
  const candidates = db
    .prepare(`SELECT content FROM messages WHERE ${col} = ? AND id > ? AND user_id != ? AND content LIKE ? ESCAPE '\\' LIMIT 200`)
    .all(targetId, after, userId, `%@${likeEscape(username)}%`) as { content: string }[];
  return { unread, mentions: candidates.filter((c) => mentionsUser(c.content, username)).length };
}

/** Tudo de uma vez: não lidas e menções de cada canal e conversa da pessoa, e o que ela silenciou. */
export function snapshot(db: Db, userId: number): Snapshot {
  const username = (db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string }).username;
  const channels: Record<number, PlaceCount> = {};
  const dms: Record<number, PlaceCount> = {};
  const chRows = db
    .prepare(
      `SELECT c.id, c.server_id, s.owner_id, c.private FROM channels c JOIN members m ON m.server_id = c.server_id
       JOIN servers s ON s.id = c.server_id WHERE m.user_id = ? AND c.type = 'text'`,
    )
    .all(userId) as { id: number; server_id: number; owner_id: number; private: number }[];
  for (const ch of chRows) if (canSeeChannel(db, ch, userId)) channels[ch.id] = count(db, userId, username, "channel", ch.id);
  const dmRows = db.prepare("SELECT id FROM dm_conversations WHERE user_a = ? OR user_b = ?").all(userId, userId) as { id: number }[];
  for (const { id } of dmRows) dms[id] = count(db, userId, username, "dm", id);
  const mutes = db.prepare("SELECT kind, target_id FROM mutes WHERE user_id = ?").all(userId) as { kind: MuteKind; target_id: number }[];
  const ids = (k: MuteKind) => mutes.filter((m) => m.kind === k).map((m) => m.target_id);
  return { channels, dms, mutes: { channels: ids("channel"), servers: ids("server"), dms: ids("dm") } };
}

/** Marca o lugar como lido até a última mensagem (nunca volta atrás). Devolve o id marcado. */
export function markRead(db: Db, userId: number, kind: PlaceKind, targetId: number): number {
  const col = kind === "channel" ? "channel_id" : "dm_id";
  const max = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE ${col} = ?`).get(targetId) as { m: number }).m;
  db.prepare(
    `INSERT INTO read_state (user_id, kind, target_id, last_read_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, kind, target_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
  ).run(userId, kind, targetId, max);
  return max;
}

export function setMute(db: Db, userId: number, kind: MuteKind, targetId: number, muted: boolean) {
  if (muted) db.prepare("INSERT OR IGNORE INTO mutes (user_id, kind, target_id) VALUES (?, ?, ?)").run(userId, kind, targetId);
  else db.prepare("DELETE FROM mutes WHERE user_id = ? AND kind = ? AND target_id = ?").run(userId, kind, targetId);
}
