import { runCommand } from "../commands.js";
import { Router } from "express";
import { removeAudioFile } from "../audioFiles.js";
import { PROFILE_COLUMNS, toProfile, type ProfileRow } from "../profiles.js";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import {
  addMessage,
  deleteMessage,
  editMessage,
  findMessageAuthor,
  isAudioMessage,
  messageInTarget,
  MAX_CONTENT,
  parseBefore,
  parseContent,
  recentMessages,
} from "../messageStore.js";

interface DmRow {
  id: number;
  user_a: number;
  user_b: number;
}

/** A conversa, se o usuário for um dos dois participantes. */
export function dmForParticipant(db: Db, dmId: number, userId: number) {
  if (!Number.isInteger(dmId)) return undefined;
  return db
    .prepare("SELECT id, user_a, user_b FROM dm_conversations WHERE id = ? AND (user_a = ? OR user_b = ?)")
    .get(dmId, userId, userId) as DmRow | undefined;
}

function shareAServer(db: Db, a: number, b: number): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM members m1 JOIN members m2 ON m2.server_id = m1.server_id
       WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 1`,
    )
    .get(a, b);
}

export function dmsRouter(db: Db, cfg: AuthConfig, hub: Hub, audioDir: string) {
  const router = Router();
  router.use(requireAuth(cfg));

  const otherUser = (userId: number) => {
    const u = db.prepare(`SELECT u.id, u.username, ${PROFILE_COLUMNS} FROM users u WHERE u.id = ?`).get(userId) as unknown as ProfileRow & { id: number; username: string };
    return { id: u.id, username: u.username, online: hub.isOnline(u.id), ...toProfile(u) };
  };

  /** Conversas que já têm mensagem, da mais recente para a mais antiga. */
  router.get("/", (_req, res) => {
    const me = res.locals.userId as number;
    const rows = db
      .prepare(
        `SELECT d.id, d.user_a, d.user_b FROM dm_conversations d
         WHERE (d.user_a = ? OR d.user_b = ?)
           AND EXISTS (SELECT 1 FROM messages m WHERE m.dm_id = d.id)
         ORDER BY (SELECT MAX(m.id) FROM messages m WHERE m.dm_id = d.id) DESC`,
      )
      .all(me, me) as unknown as DmRow[];
    res.json({ dms: rows.map((d) => ({ id: d.id, user: otherUser(d.user_a === me ? d.user_b : d.user_a) })) });
  });

  /** Abre (ou acha) a conversa com outra pessoa. */
  router.post("/", (req, res) => {
    const me = res.locals.userId as number;
    const target = req.body?.userId;
    if (!Number.isInteger(target)) {
      res.status(400).json({ error: "Informe com quem conversar" });
      return;
    }
    if (target === me) {
      res.status(400).json({ error: "Você não pode enviar mensagem para si mesmo" });
      return;
    }
    // Só dá para chamar quem divide um servidor com você; para o resto, "não existe"
    if (!shareAServer(db, me, target)) {
      res.status(404).json({ error: "Usuário não encontrado" });
      return;
    }

    const [a, b] = me < target ? [me, target] : [target, me];
    const created = db.prepare("INSERT OR IGNORE INTO dm_conversations (user_a, user_b) VALUES (?, ?)").run(a, b);
    const row = db.prepare("SELECT id FROM dm_conversations WHERE user_a = ? AND user_b = ?").get(a, b) as { id: number };
    res.status(created.changes > 0 ? 201 : 200).json({ dm: { id: row.id, user: otherUser(target) } });
  });

  router.get("/:id/messages", (req, res) => {
    const dm = dmForParticipant(db, Number(req.params.id), res.locals.userId as number);
    if (!dm) {
      res.status(404).json({ error: "Conversa não encontrada" });
      return;
    }
    const before = parseBefore(req.query.before);
    if (before === null) {
      res.status(400).json({ error: "Parâmetro before inválido" });
      return;
    }
    res.json(recentMessages(db, { dmId: dm.id }, null, before));
  });

  router.post("/:id/messages", (req, res) => {
    const me = res.locals.userId as number;
    const dm = dmForParticipant(db, Number(req.params.id), me);
    if (!dm) {
      res.status(404).json({ error: "Conversa não encontrada" });
      return;
    }

    const typed = parseContent(req.body?.content);
    if (typed === null) {
      res.status(400).json({ error: `A mensagem deve ter de 1 a ${MAX_CONTENT} caracteres` });
      return;
    }
    const content = runCommand(typed);
    if (typeof content !== "string") {
      res.status(400).json({ error: content.error });
      return;
    }

    const replyTo = req.body?.replyTo ?? null;
    if (replyTo !== null && !messageInTarget(db, { dmId: dm.id }, Number(replyTo))) {
      res.status(400).json({ error: "Mensagem respondida não encontrada" });
      return;
    }
    const message = addMessage(db, { dmId: dm.id }, me, content, null, replyTo === null ? null : Number(replyTo));
    hub.publishToUsers([dm.user_a, dm.user_b], { type: "message.created", message });
    hub.notifyMessage(message);
    res.status(201).json({ message });
  });

  // Em conversa direta só o autor edita e apaga (não há "dono" para moderar)
  router.patch("/:id/messages/:messageId", (req, res) => {
    const me = res.locals.userId as number;
    const dm = dmForParticipant(db, Number(req.params.id), me);
    const author = dm && findMessageAuthor(db, { dmId: dm.id }, Number(req.params.messageId));
    if (!dm || author === undefined) {
      res.status(404).json({ error: "Mensagem não encontrada" });
      return;
    }
    if (author !== me) {
      res.status(403).json({ error: "Só o autor pode editar a mensagem" });
      return;
    }
    if (isAudioMessage(db, Number(req.params.messageId))) {
      res.status(400).json({ error: "Mensagens de áudio não podem ser editadas" });
      return;
    }
    const content = parseContent(req.body?.content);
    if (content === null) {
      res.status(400).json({ error: `A mensagem deve ter de 1 a ${MAX_CONTENT} caracteres` });
      return;
    }
    const message = editMessage(db, Number(req.params.messageId), content, null);
    hub.publishToUsers([dm.user_a, dm.user_b], { type: "message.updated", message });
    res.json({ message });
  });

  router.delete("/:id/messages/:messageId", (req, res) => {
    const me = res.locals.userId as number;
    const dm = dmForParticipant(db, Number(req.params.id), me);
    const author = dm && findMessageAuthor(db, { dmId: dm.id }, Number(req.params.messageId));
    if (!dm || author === undefined) {
      res.status(404).json({ error: "Mensagem não encontrada" });
      return;
    }
    if (author !== me) {
      res.status(403).json({ error: "Só o autor pode apagar a mensagem" });
      return;
    }
    const messageId = Number(req.params.messageId);
    deleteMessage(db, messageId);
    void removeAudioFile(audioDir, messageId);
    hub.publishToUsers([dm.user_a, dm.user_b], {
      type: "message.deleted",
      id: messageId,
      channelId: null,
      dmId: dm.id,
      serverId: null,
    });
    res.status(204).end();
  });

  return router;
}
