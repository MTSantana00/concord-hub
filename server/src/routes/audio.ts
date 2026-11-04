import express, { Router } from "express";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { audioPath } from "../audioFiles.js";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { addAudioMessage, deleteMessage, type Target } from "../messageStore.js";
import { canPostInChannel, sendBlock } from "../channelAccess.js";
import { READ_ONLY_ERROR, channelForMember } from "./messages.js";
import { dmForParticipant } from "./dms.js";

export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_MS = 5 * 60 * 1000;

/** Tipos que os navegadores gravam: WebM (Chrome/Firefox/Edge), MP4 (Safari) e Ogg (Firefox). */
const FORMATS: Record<string, (b: Buffer) => boolean> = {
  "audio/webm": (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  "audio/mp4": (b) => b.length > 12 && b.toString("latin1", 4, 8) === "ftyp",
  "audio/ogg": (b) => b.length > 4 && b.toString("latin1", 0, 4) === "OggS",
};

/** Tipo do arquivo (sem parâmetros como codecs), se for um áudio aceito e o conteúdo bater com ele. */
function checkedMime(contentType: string | undefined, body: unknown): string | null {
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const check = FORMATS[mime];
  return check && Buffer.isBuffer(body) && check(body) ? mime : null;
}

/** `?ms=` : duração em milissegundos, de 1 ms até 5 minutos; null se inválida. */
function parseDuration(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d{0,8}$/.test(raw)) return null;
  const ms = Number(raw);
  return ms <= MAX_AUDIO_MS ? ms : null;
}

/**
 * Mensagens de áudio:
 *  POST /api/channels/:id/audio?ms=N   e   POST /api/dms/:id/audio?ms=N   (corpo = o arquivo)
 *  GET  /api/audio/:messageId          (só quem pode ler a conversa)
 */
export function audioRouter(db: Db, cfg: AuthConfig, hub: Hub, audioDir: string) {
  const router = Router();
  const auth = requireAuth(cfg);
  const rawBody = express.raw({ type: (req) => (req.headers["content-type"] ?? "").startsWith("audio/"), limit: MAX_AUDIO_BYTES });

  /** Valida o corpo, cria a mensagem, grava o arquivo e devolve a mensagem (ou responde o erro). */
  async function store(req: express.Request, res: express.Response, target: Target, userId: number, serverId: number | null) {
    const durationMs = parseDuration(req.query.ms);
    if (durationMs === null) {
      res.status(400).json({ error: "A duração do áudio deve ser de até 5 minutos" });
      return null;
    }
    const mime = checkedMime(req.headers["content-type"], req.body);
    if (!mime) {
      res.status(415).json({ error: "Envie um áudio WebM, MP4 ou Ogg" });
      return null;
    }
    const message = addAudioMessage(db, target, userId, durationMs, mime, serverId);
    try {
      await mkdir(resolve(audioDir), { recursive: true });
      await writeFile(audioPath(audioDir, message.id), req.body as Buffer);
    } catch {
      deleteMessage(db, message.id);
      res.status(500).json({ error: "Não foi possível guardar o áudio" });
      return null;
    }
    return message;
  }

  router.post("/channels/:id/audio", auth, rawBody, async (req, res) => {
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
    const message = await store(req, res, { channelId: channel.id }, userId, channel.server_id);
    if (!message) return;
    hub.publishToChannel(channel.id, { type: "message.created", message });
    hub.notifyMessage(message);
    res.status(201).json({ message });
  });

  router.post("/dms/:id/audio", auth, rawBody, async (req, res) => {
    const me = res.locals.userId as number;
    const dm = dmForParticipant(db, Number(req.params.id), me);
    if (!dm) {
      res.status(404).json({ error: "Conversa não encontrada" });
      return;
    }
    const message = await store(req, res, { dmId: dm.id }, me, null);
    if (!message) return;
    hub.publishToUsers([dm.user_a, dm.user_b], { type: "message.created", message });
    hub.notifyMessage(message);
    res.status(201).json({ message });
  });

  router.get("/audio/:messageId", auth, (req, res) => {
    const userId = res.locals.userId as number;
    const id = Number(req.params.messageId);
    const row = Number.isInteger(id)
      ? (db.prepare("SELECT channel_id, dm_id, audio_mime FROM messages WHERE id = ? AND audio_ms IS NOT NULL").get(id) as
          | { channel_id: number | null; dm_id: number | null; audio_mime: string }
          | undefined)
      : undefined;
    const allowed =
      row && (row.channel_id !== null ? channelForMember(db, row.channel_id, userId) : dmForParticipant(db, row.dm_id!, userId));
    if (!row || !allowed) {
      res.status(404).json({ error: "Áudio não encontrado" });
      return;
    }
    res.type(row.audio_mime);
    res.set("X-Content-Type-Options", "nosniff");
    // Sem guardar por tempo: o navegador revalida sempre, então áudio apagado (ou de quem saiu) não reaparece do cache
    res.set("Cache-Control", "private, no-cache");
    res.sendFile(audioPath(audioDir, id), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Áudio não encontrado" });
    });
  });

  return router;
}
