import { Router } from "express";
import { removeAudioFile } from "../audioFiles.js";
import { logAction } from "../audit.js";
import { can } from "../roles.js";
import { canPostInChannel, canSeeChannel, sendBlock } from "../channelAccess.js";
import { runCommand } from "../commands.js";
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

/** O canal, se o usuário for membro do servidor dele (com o dono do servidor, para moderar). */
export function channelForMember(db: Db, channelId: number, userId: number) {
  if (!Number.isInteger(channelId)) return undefined;
  const ch = db
    .prepare(
      `SELECT c.id, c.server_id, s.owner_id, c.read_only, c.private FROM channels c
       JOIN servers s ON s.id = c.server_id
       JOIN members m ON m.server_id = c.server_id
       WHERE c.id = ? AND m.user_id = ? AND c.type = 'text'`,
    )
    .get(channelId, userId) as { id: number; server_id: number; owner_id: number; read_only: number; private: number } | undefined;
  return ch && canSeeChannel(db, ch, userId) ? ch : undefined; // canal privado que não é seu: some, como se não existisse
}

export const READ_ONLY_ERROR = "Este canal é somente leitura";

export function messagesRouter(db: Db, cfg: AuthConfig, hub: Hub, audioDir: string) {
  const router = Router();
  router.use(requireAuth(cfg));

  router.get("/:id/messages", (req, res) => {
    const channel = channelForMember(db, Number(req.params.id), res.locals.userId as number);
    if (!channel) {
      res.status(404).json({ error: "Canal não encontrado" });
      return;
    }
    const before = parseBefore(req.query.before);
    if (before === null) {
      res.status(400).json({ error: "Parâmetro before inválido" });
      return;
    }
    res.json(recentMessages(db, { channelId: channel.id }, channel.server_id, before));
  });

  router.post("/:id/messages", (req, res) => {
    const userId = res.locals.userId as number;
    const channel = channelForMember(db, Number(req.params.id), userId);
    if (!channel) {
      res.status(404).json({ error: "Canal não encontrado" });
      return;
    }

    if (!canPostInChannel(db, channel, userId)) {
      res.status(403).json({ error: READ_ONLY_ERROR });
      return;
    }
    const block = sendBlock(db, channel, userId);
    if (block) {
      res.status(block.status).json({ error: block.error, retryAfter: block.retryAfter });
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
    if (replyTo !== null && !messageInTarget(db, { channelId: channel.id }, Number(replyTo))) {
      res.status(400).json({ error: "Mensagem respondida não encontrada" });
      return;
    }
    const message = addMessage(db, { channelId: channel.id }, userId, content, channel.server_id, replyTo === null ? null : Number(replyTo));
    hub.publishToChannel(channel.id, { type: "message.created", message });
    hub.notifyMessage(message);
    res.status(201).json({ message });
  });

  // Editar: só o autor
  router.patch("/:id/messages/:messageId", (req, res) => {
    const userId = res.locals.userId as number;
    const channel = channelForMember(db, Number(req.params.id), userId);
    const author = channel && findMessageAuthor(db, { channelId: channel.id }, Number(req.params.messageId));
    if (!channel || author === undefined) {
      res.status(404).json({ error: "Mensagem não encontrada" });
      return;
    }
    if (author !== userId) {
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

    const message = editMessage(db, Number(req.params.messageId), content, channel.server_id);
    hub.publishToChannel(channel.id, { type: "message.updated", message });
    res.json({ message });
  });

  // Apagar: o autor, ou o dono do servidor (moderação)
  router.delete("/:id/messages/:messageId", (req, res) => {
    const userId = res.locals.userId as number;
    const channel = channelForMember(db, Number(req.params.id), userId);
    const author = channel && findMessageAuthor(db, { channelId: channel.id }, Number(req.params.messageId));
    if (!channel || author === undefined) {
      res.status(404).json({ error: "Mensagem não encontrada" });
      return;
    }
    const moderando = author !== userId;
    if (moderando && !can(db, channel.server_id, userId, "manage_messages")) {
      res.status(403).json({ error: "Só o autor ou quem modera o servidor pode apagar a mensagem" });
      return;
    }

    const messageId = Number(req.params.messageId);
    deleteMessage(db, messageId);
    void removeAudioFile(audioDir, messageId);
    if (moderando) logAction(db, channel.server_id, userId, "message.deleted_by_mod", author, "");
    hub.publishToChannel(channel.id, {
      type: "message.deleted",
      id: messageId,
      channelId: channel.id,
      dmId: null,
      serverId: channel.server_id,
    });
    res.status(204).end();
  });

  return router;
}
