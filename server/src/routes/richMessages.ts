import express, { Router, type Response } from "express";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { audioPath, removeAudioFile } from "../audioFiles.js";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { detectAttachmentImage } from "../images.js";
import {
  MAX_CONTENT,
  MAX_PINS,
  insertMessage,
  loadMessage,
  messageInTarget,
  parseContent,
  pinCount,
  pinnedMessages,
  searchMessages,
  setPinned,
  toggleReaction,
  deleteMessage,
  type Attachment,
  type Target,
} from "../messageStore.js";
import { can } from "../roles.js";
import { canPostInChannel, sendBlock, type SendBlock } from "../channelAccess.js";
import { READ_ONLY_ERROR, channelForMember } from "./messages.js";
import { dmForParticipant } from "./dms.js";

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_NAME = 120;

/** Arquivos que podem rodar ou abrir como página no computador de quem baixa: não passam. */
const BLOCKED_EXT = /\.(exe|bat|cmd|com|scr|msi|dll|js|mjs|vbs|vbe|wsf|hta|ps1|jar|sh|apk|app|dmg|lnk|reg|html?|xhtml|svg)$/i;
// Um emoji (com variações, tons de pele e junções) ou um número/símbolo em quadrinho
const EMOJI = /^(?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*|[#*0-9]️?⃣|\p{Regional_Indicator}{2})$/u;

type Kind = "channels" | "dms";

interface Ctx {
  target: Target;
  serverId: number | null;
  publish: (event: unknown) => void;
  /** Pode fixar e desafixar: em canal, quem modera mensagens; em conversa direta, os dois. */
  canPin: boolean;
  /** Pode escrever (canal somente leitura só para quem gerencia). */
  canPost: boolean;
  /** Timeout ou modo lento que impede de enviar agora (null = pode enviar). */
  block: SendBlock | null;
}

/** Nome do arquivo sem caminho nem caracteres de controle; null se vazio. */
export function cleanFileName(raw: unknown): string {
  const base = (typeof raw === "string" ? raw : "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);
  return name === "" || /[. ]$/.test(name) ? "arquivo" : name;
}

/**
 * Recursos extras das mensagens, iguais em canais e em conversas diretas:
 * anexos (e o download), reações, fixar, busca. Quem pode ler a conversa pode usar; fixar pede permissão.
 */
export function richMessagesRouter(db: Db, cfg: AuthConfig, hub: Hub, mediaDir: string) {
  const router = Router();
  const auth = requireAuth(cfg);
  const rawFile = express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES });

  /** A conversa e o que a pessoa pode nela; responde 404 e devolve null se não for dela. */
  function context(kind: Kind, rawId: string, userId: number, res: Response): Ctx | null {
    const id = Number(rawId);
    if (kind === "channels") {
      const ch = channelForMember(db, id, userId);
      if (!ch) {
        res.status(404).json({ error: "Canal não encontrado" });
        return null;
      }
      return {
        target: { channelId: ch.id },
        serverId: ch.server_id,
        publish: (e) => hub.publishToChannel(ch.id, e),
        canPin: can(db, ch.server_id, userId, "manage_messages"),
        canPost: canPostInChannel(db, ch, userId),
        block: sendBlock(db, ch, userId),
      };
    }
    const dm = dmForParticipant(db, id, userId);
    if (!dm) {
      res.status(404).json({ error: "Conversa não encontrada" });
      return null;
    }
    return { target: { dmId: dm.id }, serverId: null, publish: (e) => hub.publishToUsers([dm.user_a, dm.user_b], e), canPin: true, canPost: true, block: null };
  }

  const place = (t: Target) => (t.channelId !== undefined ? { channelId: t.channelId } : { dmId: t.dmId });

  for (const kind of ["channels", "dms"] as Kind[]) {
    // ------------------------------------------------------------ anexos
    router.post(`/${kind}/:id/attachments`, auth, rawFile, async (req, res) => {
      const userId = res.locals.userId as number;
      const ctx = context(kind, req.params.id, userId, res);
      if (!ctx) return;
      if (!ctx.canPost) {
        res.status(403).json({ error: READ_ONLY_ERROR });
        return;
      }
      if (ctx.block) {
        res.status(ctx.block.status).json({ error: ctx.block.error, retryAfter: ctx.block.retryAfter });
        return;
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: "Nenhum arquivo recebido" });
        return;
      }
      const name = cleanFileName(req.query.name);
      if (BLOCKED_EXT.test(name)) {
        res.status(415).json({ error: "Esse tipo de arquivo não é permitido (programas, scripts e páginas)" });
        return;
      }
      const caption = req.query.caption === undefined || req.query.caption === "" ? "" : parseContent(req.query.caption);
      if (caption === null) {
        res.status(400).json({ error: `A legenda deve ter até ${MAX_CONTENT} caracteres` });
        return;
      }
      let replyTo: number | null = null;
      if (req.query.replyTo !== undefined) {
        replyTo = Number(req.query.replyTo);
        if (!messageInTarget(db, ctx.target, replyTo)) {
          res.status(400).json({ error: "Mensagem respondida não encontrada" });
          return;
        }
      }

      const imageMime = detectAttachmentImage(body);
      const attachment: Attachment = imageMime
        ? { name, mime: imageMime, size: body.length, kind: "image" }
        : { name, mime: "application/octet-stream", size: body.length, kind: "file" };
      const message = insertMessage(db, ctx.target, userId, { content: caption, replyTo, attachment }, ctx.serverId);
      try {
        await mkdir(resolve(mediaDir), { recursive: true });
        await writeFile(audioPath(mediaDir, message.id), body);
      } catch {
        deleteMessage(db, message.id);
        res.status(500).json({ error: "Não foi possível guardar o arquivo" });
        return;
      }
      ctx.publish({ type: "message.created", message });
      hub.notifyMessage(message);
      res.status(201).json({ message });
    });

    // ------------------------------------------------------------ reações
    router.post(`/${kind}/:id/messages/:messageId/reactions`, auth, (req, res) => {
      const ctx = context(kind, req.params.id, res.locals.userId as number, res);
      if (!ctx) return;
      const messageId = Number(req.params.messageId);
      if (!messageInTarget(db, ctx.target, messageId)) {
        res.status(404).json({ error: "Mensagem não encontrada" });
        return;
      }
      const emoji = req.body?.emoji;
      if (typeof emoji !== "string" || emoji.length > 32 || !EMOJI.test(emoji)) {
        res.status(400).json({ error: "Escolha um emoji" });
        return;
      }
      const reactions = toggleReaction(db, messageId, res.locals.userId as number, emoji);
      if (reactions === null) {
        res.status(400).json({ error: "Essa mensagem já tem o máximo de 20 emojis diferentes" });
        return;
      }
      ctx.publish({ type: "message.reactions", messageId, ...place(ctx.target), serverId: ctx.serverId, reactions });
      res.json({ reactions });
    });

    // ------------------------------------------------------------ fixar
    for (const method of ["put", "delete"] as const) {
      router[method](`/${kind}/:id/messages/:messageId/pin`, auth, (req, res) => {
        const userId = res.locals.userId as number;
        const ctx = context(kind, req.params.id, userId, res);
        if (!ctx) return;
        const messageId = Number(req.params.messageId);
        if (!messageInTarget(db, ctx.target, messageId)) {
          res.status(404).json({ error: "Mensagem não encontrada" });
          return;
        }
        if (!ctx.canPin) {
          res.status(403).json({ error: "Seu cargo não pode fixar mensagens" });
          return;
        }
        if (method === "put") {
          if (pinCount(db, ctx.target) >= MAX_PINS) {
            res.status(400).json({ error: `Este lugar já tem o máximo de ${MAX_PINS} mensagens fixadas` });
            return;
          }
          setPinned(db, messageId, userId);
        } else {
          setPinned(db, messageId, null);
        }
        const message = loadMessage(db, messageId, ctx.serverId)!;
        ctx.publish({ type: "message.updated", message });
        res.json({ message });
      });
    }

    router.get(`/${kind}/:id/pins`, auth, (req, res) => {
      const ctx = context(kind, req.params.id, res.locals.userId as number, res);
      if (!ctx) return;
      res.json({ messages: pinnedMessages(db, ctx.target, ctx.serverId) });
    });

    // ------------------------------------------------------------ busca
    router.get(`/${kind}/:id/search`, auth, (req, res) => {
      const ctx = context(kind, req.params.id, res.locals.userId as number, res);
      if (!ctx) return;
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (q.length < 2 || q.length > 100) {
        res.status(400).json({ error: "Digite de 2 a 100 caracteres para buscar" });
        return;
      }
      res.json({ messages: searchMessages(db, ctx.target, ctx.serverId, q) });
    });
  }

  // ------------------------------------------------------------ baixar anexo
  router.get("/files/:messageId", auth, (req, res) => {
    const userId = res.locals.userId as number;
    const id = Number(req.params.messageId);
    const row = Number.isInteger(id)
      ? (db.prepare("SELECT channel_id, dm_id, att_name, att_mime, att_kind FROM messages WHERE id = ? AND att_name IS NOT NULL").get(id) as
          | { channel_id: number | null; dm_id: number | null; att_name: string; att_mime: string; att_kind: "image" | "file" }
          | undefined)
      : undefined;
    const allowed =
      row && (row.channel_id !== null ? channelForMember(db, row.channel_id, userId) : dmForParticipant(db, row.dm_id!, userId));
    if (!row || !allowed) {
      res.status(404).json({ error: "Arquivo não encontrado" });
      return;
    }
    const filename = encodeURIComponent(row.att_name).replace(/['()]/g, escape);
    res.type(row.att_kind === "image" ? row.att_mime : "application/octet-stream");
    // Imagem aparece na conversa; qualquer outra coisa só baixa, e nada pode rodar a partir daqui
    res.set("Content-Disposition", `${row.att_kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${filename}`);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Security-Policy", "default-src 'none'; sandbox");
    res.set("Cache-Control", "private, no-cache");
    res.sendFile(audioPath(mediaDir, id), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Arquivo não encontrado" });
    });
  });

  return router;
}

export { removeAudioFile };
