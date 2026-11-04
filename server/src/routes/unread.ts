import { Router } from "express";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { markRead, setMute, snapshot, type MuteKind } from "../unread.js";
import { dmForParticipant } from "./dms.js";
import { channelForMember } from "./messages.js";

/** Não lidas, menções e silenciar: tudo é da própria pessoa, e os outros aparelhos dela são avisados. */
export function unreadRouter(db: Db, cfg: AuthConfig, hub: Hub) {
  const router = Router();
  const auth = requireAuth(cfg);

  router.get("/unread", auth, (_req, res) => {
    res.json(snapshot(db, res.locals.userId as number));
  });

  router.put("/channels/:id/read", auth, (req, res) => {
    const userId = res.locals.userId as number;
    const ch = channelForMember(db, Number(req.params.id), userId);
    if (!ch) {
      res.status(404).json({ error: "Canal não encontrado" });
      return;
    }
    markRead(db, userId, "channel", ch.id);
    hub.publishToUsers([userId], { type: "read.updated", kind: "channel", id: ch.id });
    res.status(204).end();
  });

  router.put("/dms/:id/read", auth, (req, res) => {
    const userId = res.locals.userId as number;
    const dm = dmForParticipant(db, Number(req.params.id), userId);
    if (!dm) {
      res.status(404).json({ error: "Conversa não encontrada" });
      return;
    }
    markRead(db, userId, "dm", dm.id);
    hub.publishToUsers([userId], { type: "read.updated", kind: "dm", id: dm.id });
    res.status(204).end();
  });

  function allowed(kind: string, id: number, userId: number): boolean {
    if (!Number.isInteger(id)) return false;
    if (kind === "channel") return !!channelForMember(db, id, userId);
    if (kind === "dm") return !!dmForParticipant(db, id, userId);
    if (kind === "server") return !!db.prepare("SELECT 1 FROM members WHERE server_id = ? AND user_id = ?").get(id, userId);
    return false;
  }

  for (const method of ["put", "delete"] as const) {
    router[method]("/mutes/:kind/:id", auth, (req, res) => {
      const userId = res.locals.userId as number;
      const kind = req.params.kind as MuteKind;
      const id = Number(req.params.id);
      if (!allowed(kind, id, userId)) {
        res.status(404).json({ error: "Não encontrado" });
        return;
      }
      const muted = method === "put";
      setMute(db, userId, kind, id, muted);
      hub.publishToUsers([userId], { type: "mute.updated", kind, id, muted });
      res.status(204).end();
    });
  }

  return router;
}
