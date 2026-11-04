import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { Router } from "express";
import { logAction } from "../audit.js";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { callRoomName, httpUrlOf, roomName, type MediaConfig, type MediaPool } from "../mediaPool.js";
import { standing } from "../roles.js";

export type { MediaConfig } from "../mediaPool.js";

/** Quem derruba a ligação de mídia de uma pessoa (o LiveKit de verdade; os testes trocam por um falso). */
export type RoomServiceFactory = (c: MediaConfig) => { removeParticipant(room: string, identity: string): Promise<unknown> };
const realRoomService: RoomServiceFactory = (c) => new RoomServiceClient(httpUrlOf(c.url), c.apiKey, c.apiSecret);

export { callRoomName, roomName } from "../mediaPool.js";

/**
 * POST /api/voice/token { channelId } -> { token, url }
 * Só quem está sentado na sala de voz (entrou pelo WebSocket, que já conferiu que é membro) recebe a chave
 * para entrar na sala do LiveKit; ela só abre aquela sala.
 */
export function voiceTokenRouter(db: Db, cfg: AuthConfig, hub: Hub, pool: MediaPool, makeRoomService: RoomServiceFactory = realRoomService) {
  const router = Router();
  router.use(requireAuth(cfg));

  router.post("/token", async (req, res) => {
    const userId = res.locals.userId as number;
    const { channelId, dmId } = req.body ?? {};
    let room: string;
    if (Number.isInteger(dmId)) {
      // Chamada na DM: só os dois participantes, e só depois de atendida
      if (hub.calls.activeFor(userId)?.dmId !== dmId) {
        res.status(403).json({ error: "Não há chamada em andamento" });
        return;
      }
      room = callRoomName(dmId);
    } else if (Number.isInteger(channelId)) {
      if (hub.voice.seatOf(userId)?.channelId !== channelId) {
        res.status(403).json({ error: "Entre na sala de voz primeiro" });
        return;
      }
      room = roomName(channelId);
    } else {
      res.status(400).json({ error: "Informe o canal de voz ou a conversa" });
      return;
    }

    const user = db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string };
    // A sala fica presa ao servidor de mídia em que começou; quem entra depois vai para o mesmo
    const media = pool.pick(room, userId);
    const token = new AccessToken(media.apiKey, media.apiSecret, {
      identity: String(userId),
      name: user.username,
      ttl: "1h",
    });
    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    res.json({ token: await token.toJwt(), url: media.url });
  });

  /**
   * POST /api/voice/kick { userId }: tira a pessoa da sala de voz em que está agora.
   * Quem pode: dono e cargos com "expulsar e banir" do servidor da sala; ninguém tira o dono nem a si mesmo.
   */
  router.post("/kick", async (req, res) => {
    const me = res.locals.userId as number;
    const target = req.body?.userId;
    const seat = Number.isInteger(target) ? hub.voice.seatOf(target) : undefined;
    if (!seat || target === me) {
      res.status(404).json({ error: "Essa pessoa não está em uma sala de voz" });
      return;
    }
    const mine = standing(db, seat.serverId, me);
    if (!mine?.permissions.has("kick_ban")) {
      res.status(403).json({ error: "Seu cargo não pode tirar pessoas da sala" });
      return;
    }
    if (standing(db, seat.serverId, target)?.isOwner) {
      res.status(403).json({ error: "O dono do servidor não pode ser tirado da sala" });
      return;
    }
    // O servidor da sala tem que ser lido ANTES de tirar a pessoa: ao sair, a sala pode sumir do pool
    const room = roomName(seat.channelId);
    const media = pool.configOf(pool.serverOf(room) ?? "fallback");
    hub.voice.kick(target, me);
    logAction(db, seat.serverId, me, "voice.kicked", target);
    // Também derruba a ligação de mídia, se o servidor de mídia responder (sem ele, a chave de 1 h só vale até vencer)
    try {
      await Promise.race([
        makeRoomService(media).removeParticipant(room, String(target)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]);
    } catch {
      // melhor esforço
    }
    res.status(204).end();
  });

  return router;
}
