import { Router } from "express";
import { canPostInChannel, sendBlock } from "../channelAccess.js";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { insertMessage, loadMessage } from "../messageStore.js";
import { READ_ONLY_ERROR, channelForMember } from "./messages.js";

export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 10;
export const MAX_QUESTION = 200;
export const MAX_OPTION = 80;

/** Pergunta e opções de uma enquete, ou o erro em texto. Opções repetidas ou vazias são descartadas. */
export function parsePoll(body: Record<string, unknown> | undefined): { question: string; options: string[]; multiple: boolean } | string {
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (question.length < 1 || question.length > MAX_QUESTION) return `A pergunta deve ter de 1 a ${MAX_QUESTION} caracteres`;
  if (!Array.isArray(body?.options)) return "Informe as opções da enquete";
  const options: string[] = [];
  for (const raw of body.options as unknown[]) {
    if (typeof raw !== "string") return "As opções devem ser texto";
    const text = raw.trim();
    if (text.length > MAX_OPTION) return `Cada opção deve ter até ${MAX_OPTION} caracteres`;
    if (text && !options.some((o) => o.toLowerCase() === text.toLowerCase())) options.push(text);
  }
  if (options.length < MIN_POLL_OPTIONS || options.length > MAX_POLL_OPTIONS) return `A enquete precisa de ${MIN_POLL_OPTIONS} a ${MAX_POLL_OPTIONS} opções diferentes`;
  if (body?.multiple !== undefined && typeof body.multiple !== "boolean") return "multiple deve ser verdadeiro ou falso";
  return { question, options, multiple: body?.multiple === true };
}

/** Enquetes em canais: criar e votar. Quem pode escrever no canal pode criar; quem enxerga o canal pode votar. */
export function pollsRouter(db: Db, cfg: AuthConfig, hub: Hub) {
  const router = Router();
  router.use(requireAuth(cfg));

  router.post("/:id/polls", (req, res) => {
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
    const poll = parsePoll(req.body);
    if (typeof poll === "string") {
      res.status(400).json({ error: poll });
      return;
    }

    const message = (() => {
      db.exec("BEGIN");
      try {
        const m = insertMessage(db, { channelId: channel.id }, userId, { content: poll.question, pollMultiple: poll.multiple }, channel.server_id);
        const add = db.prepare("INSERT INTO poll_options (message_id, position, text) VALUES (?, ?, ?)");
        poll.options.forEach((text, i) => add.run(m.id, i, text));
        db.exec("COMMIT");
        return loadMessage(db, m.id, channel.server_id)!;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    })();
    hub.publishToChannel(channel.id, { type: "message.created", message });
    hub.notifyMessage(message);
    res.status(201).json({ message });
  });

  // Votar (ou tirar o voto) numa opção. Em escolha única, votar numa opção troca o voto anterior.
  router.post("/:id/messages/:messageId/vote", (req, res) => {
    const userId = res.locals.userId as number;
    const channel = channelForMember(db, Number(req.params.id), userId);
    const messageId = Number(req.params.messageId);
    const row = channel
      ? (db.prepare("SELECT poll_multiple FROM messages WHERE id = ? AND channel_id = ?").get(messageId, channel.id) as { poll_multiple: number | null } | undefined)
      : undefined;
    if (!channel || !row || row.poll_multiple === null) {
      res.status(404).json({ error: "Enquete não encontrada" });
      return;
    }
    const optionId = Number(req.body?.optionId);
    if (!Number.isInteger(optionId) || !db.prepare("SELECT 1 FROM poll_options WHERE id = ? AND message_id = ?").get(optionId, messageId)) {
      res.status(400).json({ error: "Opção não encontrada" });
      return;
    }
    const had = db.prepare("DELETE FROM poll_votes WHERE option_id = ? AND user_id = ?").run(optionId, userId);
    if (had.changes === 0) {
      if (row.poll_multiple === 0) db.prepare("DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?").run(messageId, userId);
      db.prepare("INSERT INTO poll_votes (option_id, message_id, user_id) VALUES (?, ?, ?)").run(optionId, messageId, userId);
    }
    const message = loadMessage(db, messageId, channel.server_id)!;
    hub.publishToChannel(channel.id, { type: "message.updated", message });
    res.json({ message });
  });

  return router;
}
