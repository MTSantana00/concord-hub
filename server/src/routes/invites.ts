import { Router } from "express";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { acceptInvite } from "../joining.js";
import { listMembers } from "../members.js";
import { serverWithChannels } from "./servers.js";

export function invitesRouter(db: Db, cfg: AuthConfig, hub: Hub) {
  const router = Router();
  router.use(requireAuth(cfg));

  router.post("/:code/join", (req, res) => {
    const userId = res.locals.userId as number;
    db.exec("BEGIN");
    let result;
    try {
      result = acceptInvite(db, req.params.code, userId);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    if (result.joined) {
      // Entrou agora: quem está com o servidor aberto vê o novo membro na hora
      const member = listMembers(db, hub, result.serverId).find((m) => m.id === userId);
      hub.publishToServer(result.serverId, { type: "member.joined", serverId: result.serverId, member });
    }
    res.json({ server: serverWithChannels(db, result.serverId, userId) });
  });

  return router;
}
