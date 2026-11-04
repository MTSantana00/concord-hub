import type { Db } from "./db.js";
import { PROFILE_COLUMNS, toProfile, type ProfileRow } from "./profiles.js";

export const MAX_CONTENT = 2000;
export const PAGE = 50;
export const MAX_REACTIONS_PER_MESSAGE = 20;
export const MAX_PINS = 50;

/** Onde a mensagem mora: num canal de servidor ou numa conversa direta. */
export type Target = { channelId: number; dmId?: never } | { dmId: number; channelId?: never };

export interface Attachment {
  name: string;
  mime: string;
  size: number;
  kind: "image" | "file";
}

interface MessageRow extends ProfileRow {
  id: number;
  channel_id: number | null;
  dm_id: number | null;
  content: string;
  created_at: string;
  edited_at: string | null;
  audio_ms: number | null;
  audio_mime: string | null;
  reply_to: number | null;
  pinned_at: string | null;
  att_name: string | null;
  att_mime: string | null;
  att_size: number | null;
  att_kind: "image" | "file" | null;
  poll_multiple: number | null;
  user_id: number;
  username: string;
  // a mensagem respondida (se ainda existir)
  rm_id: number | null;
  rm_content: string | null;
  rm_audio_ms: number | null;
  rm_att_name: string | null;
  ru_id: number | null;
  ru_username: string | null;
  ru_display_name: string | null;
}

const SELECT = `
  SELECT m.id, m.channel_id, m.dm_id, m.content, m.created_at, m.edited_at, m.audio_ms, m.audio_mime,
         m.reply_to, m.pinned_at, m.att_name, m.att_mime, m.att_size, m.att_kind, m.poll_multiple,
         m.user_id, u.username, ${PROFILE_COLUMNS},
         rm.id AS rm_id, rm.content AS rm_content, rm.audio_ms AS rm_audio_ms, rm.att_name AS rm_att_name,
         ru.id AS ru_id, ru.username AS ru_username, ru.display_name AS ru_display_name
  FROM messages m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN messages rm ON rm.id = m.reply_to
  LEFT JOIN users ru ON ru.id = rm.user_id`;

export interface ReactionInfo {
  emoji: string;
  count: number;
  users: number[];
}

export interface PollInfo {
  multiple: boolean;
  options: { id: number; text: string; users: number[] }[];
}

/** Enquetes de várias mensagens de uma vez: id da mensagem -> opções com quem votou em cada uma. */
function pollsOf(db: Db, rows: MessageRow[]): Map<number, PollInfo> {
  const out = new Map<number, PollInfo>();
  const polls = rows.filter((r) => r.poll_multiple !== null);
  if (polls.length === 0) return out;
  const ids = polls.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const options = db.prepare(`SELECT id, message_id, text FROM poll_options WHERE message_id IN (${marks}) ORDER BY position`).all(...ids) as { id: number; message_id: number; text: string }[];
  const votes = db.prepare(`SELECT option_id, user_id FROM poll_votes WHERE message_id IN (${marks}) ORDER BY rowid`).all(...ids) as { option_id: number; user_id: number }[];
  for (const r of polls) out.set(r.id, { multiple: r.poll_multiple === 1, options: [] });
  for (const o of options) out.get(o.message_id)!.options.push({ id: o.id, text: o.text, users: votes.filter((v) => v.option_id === o.id).map((v) => v.user_id) });
  return out;
}

/** Trecho curto da mensagem respondida: o texto, ou uma etiqueta quando só tem áudio ou arquivo. */
function snippet(content: string | null, audioMs: number | null, attName: string | null): string {
  if (content) return content.length > 120 ? `${content.slice(0, 117)}...` : content;
  if (audioMs !== null) return "🎤 Mensagem de áudio";
  if (attName) return `📎 ${attName}`;
  return "";
}

/** Reações de várias mensagens de uma vez: id da mensagem -> lista de emojis com quem reagiu. */
function reactionsOf(db: Db, ids: number[]): Map<number, ReactionInfo[]> {
  const out = new Map<number, ReactionInfo[]>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(`SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY rowid`)
    .all(...ids) as { message_id: number; emoji: string; user_id: number }[];
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    const hit = list.find((x) => x.emoji === r.emoji);
    if (hit) {
      hit.count++;
      hit.users.push(r.user_id);
    } else list.push({ emoji: r.emoji, count: 1, users: [r.user_id] });
    out.set(r.message_id, list);
  }
  return out;
}

/** Formato público da mensagem. serverId só existe para mensagens de canal. */
function toMessage(m: MessageRow, serverId: number | null, reactions: ReactionInfo[] = [], poll: PollInfo | null = null) {
  return {
    id: m.id,
    channelId: m.channel_id,
    dmId: m.dm_id,
    serverId,
    content: m.content,
    createdAt: m.created_at,
    editedAt: m.edited_at,
    // Mensagem de áudio: content vem vazio; o arquivo sai de GET /api/audio/<id>
    audio: m.audio_ms === null ? null : { durationMs: m.audio_ms, mime: m.audio_mime },
    // Anexo (imagem ou arquivo): o conteúdo sai de GET /api/files/<id>
    attachment: m.att_name === null ? null : ({ name: m.att_name, mime: m.att_mime, size: m.att_size, kind: m.att_kind } as Attachment),
    replyTo:
      m.reply_to === null
        ? null
        : m.rm_id === null
          ? { id: m.reply_to, deleted: true, author: null, snippet: "" }
          : {
              id: m.rm_id,
              deleted: false,
              author: { id: m.ru_id, username: m.ru_username, displayName: m.ru_display_name },
              snippet: snippet(m.rm_content, m.rm_audio_ms, m.rm_att_name),
            },
    pinned: m.pinned_at !== null,
    reactions,
    poll,
    author: { id: m.user_id, username: m.username, ...toProfile(m) },
  };
}

const toMessages = (db: Db, rows: MessageRow[], serverId: number | null) => {
  const reactions = reactionsOf(db, rows.map((r) => r.id));
  const polls = pollsOf(db, rows);
  return rows.map((m) => toMessage(m, serverId, reactions.get(m.id) ?? [], polls.get(m.id) ?? null));
};

/** Texto limpo da mensagem, ou null se for inválido (não é texto, vazio ou grande demais). */
export function parseContent(raw: unknown): string | null {
  const content = typeof raw === "string" ? raw.trim() : "";
  return content.length >= 1 && content.length <= MAX_CONTENT ? content : null;
}

/** Lê `?before=<id>`: undefined se ausente, null se não for um inteiro positivo. */
export function parseBefore(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  return Number(raw);
}

const columnOf = (target: Target) => (target.channelId !== undefined ? "channel_id" : "dm_id");
const idOf = (target: Target) => (target.channelId ?? target.dmId) as number;

/**
 * Até 50 mensagens, da mais antiga para a mais nova. Sem `before`, são as mais recentes;
 * com `before`, as 50 imediatamente anteriores àquele id. `hasMore` diz se ainda há mais antigas.
 */
export function recentMessages(db: Db, target: Target, serverId: number | null, before?: number) {
  const params: number[] = [idOf(target)];
  let where = `m.${columnOf(target)} = ?`;
  if (before !== undefined) {
    where += " AND m.id < ?";
    params.push(before);
  }
  // Pede uma a mais só para saber se existem mais antigas
  const rows = db
    .prepare(`${SELECT} WHERE ${where} ORDER BY m.id DESC LIMIT ${PAGE + 1}`)
    .all(...params) as unknown as MessageRow[];
  return { messages: toMessages(db, rows.slice(0, PAGE).reverse(), serverId), hasMore: rows.length > PAGE };
}

/** A mensagem existe NESTE canal/conversa? (para responder só a mensagens daqui) */
export function messageInTarget(db: Db, target: Target, messageId: number): boolean {
  if (!Number.isInteger(messageId)) return false;
  return !!db.prepare(`SELECT 1 FROM messages WHERE id = ? AND ${columnOf(target)} = ?`).get(messageId, idOf(target));
}

interface NewMessage {
  content: string;
  replyTo?: number | null;
  audio?: { durationMs: number; mime: string };
  attachment?: Attachment;
  pollMultiple?: boolean;
}

/** Cria a mensagem (texto, áudio ou anexo). Arquivos são gravados por quem chama, com o id devolvido. */
export function insertMessage(db: Db, target: Target, userId: number, m: NewMessage, serverId: number | null) {
  const result = db
    .prepare(
      `INSERT INTO messages (${columnOf(target)}, user_id, content, reply_to, audio_ms, audio_mime, att_name, att_mime, att_size, att_kind, poll_multiple)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      idOf(target),
      userId,
      m.content,
      m.replyTo ?? null,
      m.audio?.durationMs ?? null,
      m.audio?.mime ?? null,
      m.attachment?.name ?? null,
      m.attachment?.mime ?? null,
      m.attachment?.size ?? null,
      m.attachment?.kind ?? null,
      m.pollMultiple === undefined ? null : m.pollMultiple ? 1 : 0,
    );
  return loadMessage(db, Number(result.lastInsertRowid), serverId)!;
}

export function addMessage(db: Db, target: Target, userId: number, content: string, serverId: number | null, replyTo?: number | null) {
  return insertMessage(db, target, userId, { content, replyTo }, serverId);
}

/** Cria a mensagem de áudio (o arquivo é gravado em disco por quem chamou, com o id devolvido). */
export function addAudioMessage(db: Db, target: Target, userId: number, durationMs: number, mime: string, serverId: number | null) {
  return insertMessage(db, target, userId, { content: "", audio: { durationMs, mime } }, serverId);
}

/** A mensagem tem áudio ou anexo? (esses não se editam como texto) */
export function isAudioMessage(db: Db, messageId: number): boolean {
  const row = db.prepare("SELECT audio_ms, att_name FROM messages WHERE id = ?").get(messageId) as
    | { audio_ms: number | null; att_name: string | null }
    | undefined;
  return !!row && row.audio_ms !== null;
}

export function loadMessage(db: Db, messageId: number, serverId: number | null) {
  const row = db.prepare(`${SELECT} WHERE m.id = ?`).get(messageId) as unknown as MessageRow | undefined;
  return row ? toMessages(db, [row], serverId)[0] : null;
}

/** O autor da mensagem, se ela existir NESTE canal/conversa (id de outro lugar conta como inexistente). */
export function findMessageAuthor(db: Db, target: Target, messageId: number): number | undefined {
  if (!Number.isInteger(messageId)) return undefined;
  const row = db
    .prepare(`SELECT user_id FROM messages WHERE id = ? AND ${columnOf(target)} = ?`)
    .get(messageId, idOf(target)) as { user_id: number } | undefined;
  return row?.user_id;
}

export function editMessage(db: Db, messageId: number, content: string, serverId: number | null) {
  db.prepare("UPDATE messages SET content = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
    content,
    messageId,
  );
  return loadMessage(db, messageId, serverId)!;
}

export function deleteMessage(db: Db, messageId: number) {
  db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
}

// ---------------------------------------------------------------- reações

/** Dá ou tira a reação da pessoa. Devolve a lista nova, ou null se passaria do limite de emojis diferentes. */
export function toggleReaction(db: Db, messageId: number, userId: number, emoji: string): ReactionInfo[] | null {
  const had = db.prepare("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?").run(messageId, userId, emoji);
  if (had.changes === 0) {
    const kinds = db.prepare("SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?").get(messageId) as { n: number };
    const isNew = !db.prepare("SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ?").get(messageId, emoji);
    if (isNew && kinds.n >= MAX_REACTIONS_PER_MESSAGE) return null;
    db.prepare("INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)").run(messageId, userId, emoji);
  }
  return reactionsOf(db, [messageId]).get(messageId) ?? [];
}

// ---------------------------------------------------------------- busca e fixadas

/** Busca por texto (sem diferenciar maiúsculas) na conversa: até 50, da mais nova para a mais antiga. */
export function searchMessages(db: Db, target: Target, serverId: number | null, query: string) {
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = db
    .prepare(`${SELECT} WHERE m.${columnOf(target)} = ? AND (m.content LIKE ? ESCAPE '\\' OR m.att_name LIKE ? ESCAPE '\\') ORDER BY m.id DESC LIMIT ${PAGE}`)
    .all(idOf(target), like, like) as unknown as MessageRow[];
  return toMessages(db, rows, serverId);
}

export function pinnedMessages(db: Db, target: Target, serverId: number | null) {
  const rows = db
    .prepare(`${SELECT} WHERE m.${columnOf(target)} = ? AND m.pinned_at IS NOT NULL ORDER BY m.pinned_at DESC`)
    .all(idOf(target)) as unknown as MessageRow[];
  return toMessages(db, rows, serverId);
}

export function pinCount(db: Db, target: Target): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${columnOf(target)} = ? AND pinned_at IS NOT NULL`).get(idOf(target)) as { n: number }).n;
}

export function setPinned(db: Db, messageId: number, userId: number | null) {
  if (userId === null) db.prepare("UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?").run(messageId);
  else db.prepare("UPDATE messages SET pinned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), pinned_by = ? WHERE id = ?").run(userId, messageId);
}
