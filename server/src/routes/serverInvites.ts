import { randomBytes } from "node:crypto";
import { Router } from "express";
import { logAction } from "../audit.js";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import { invitesCounted } from "../joining.js";
import { standing } from "../roles.js";

interface InviteRow {
  code: string;
  created_by: number;
  creator: string;
  created_at: string;
  used_by: number | null;
  used_name: string | null;
  used_at: string | null;
  revoked_at: string | null;
}

const toInvite = (r: InviteRow) => ({
  code: r.code,
  createdBy: { id: r.created_by, username: r.creator },
  createdAt: r.created_at,
  usedBy: r.used_by === null ? null : { id: r.used_by, username: r.used_name ?? "(conta removida)" },
  usedAt: r.used_at,
  status: r.revoked_at ? "revoked" : r.used_by !== null ? "used" : "pending",
});

/**
 * Convites de um servidor: criar (quem tem o cargo certo, até `limit` por pessoa), listar e revogar.
 * Cada convite vale uma vez; revogar um convite pendente devolve a vaga ao limite.
 */
export function serverInvitesRouter(db: Db, cfg: AuthConfig, limit: number) {
  const router = Router();
  router.use(requireAuth(cfg));

  const quota = (userId: number) => {
    const counted = invitesCounted(db, userId);
    return { limit, used: counted, remaining: Math.max(0, limit - counted) };
  };

  router.post("/:id/invites", (req, res) => {
    const userId = res.locals.userId as number;
    const serverId = Number(req.params.id);
    const me = Number.isInteger(serverId) ? standing(db, serverId, userId) : null;
    // Quem não é membro nem fica sabendo que o servidor existe
    if (!me) {
      res.status(404).json({ error: "Servidor não encontrado" });
      return;
    }
    if (!me.permissions.has("invite")) {
      res.status(403).json({ error: "Seu cargo não pode criar convites" });
      return;
    }
    if (quota(userId).remaining === 0) {
      res.status(429).json({ error: `Você já usou seus ${limit} convites. Revogue um que ainda não foi usado para liberar uma vaga.` });
      return;
    }
    const code = randomBytes(8).toString("base64url");
    db.prepare("INSERT INTO invites (code, server_id, created_by) VALUES (?, ?, ?)").run(code, serverId, userId);
    logAction(db, serverId, userId, "invite.created", null, "");
    res.status(201).json({ code, ...quota(userId) });
  });

  /** Os meus convites; quem pode gerenciar convites vê os de todos do servidor. */
  router.get("/:id/invites", (req, res) => {
    const userId = res.locals.userId as number;
    const serverId = Number(req.params.id);
    const me = Number.isInteger(serverId) ? standing(db, serverId, userId) : null;
    if (!me) {
      res.status(404).json({ error: "Servidor não encontrado" });
      return;
    }
    const all = me.permissions.has("manage_invites");
    if (!all && !me.permissions.has("invite")) {
      res.status(403).json({ error: "Seu cargo não pode ver convites" });
      return;
    }
    const rows = db
      .prepare(
        `SELECT i.code, i.created_by, c.username AS creator, i.created_at, i.used_by, u.username AS used_name, i.used_at, i.revoked_at
         FROM invites i JOIN users c ON c.id = i.created_by LEFT JOIN users u ON u.id = i.used_by
         WHERE i.server_id = ? ${all ? "" : "AND i.created_by = ?"}
         ORDER BY i.created_at DESC, i.rowid DESC LIMIT 200`,
      )
      .all(...(all ? [serverId] : [serverId, userId])) as unknown as InviteRow[];
    res.json({ invites: rows.map(toInvite), ...quota(userId), canSeeAll: all });
  });

  router.delete("/:id/invites/:code", (req, res) => {
    const userId = res.locals.userId as number;
    const serverId = Number(req.params.id);
    const me = Number.isInteger(serverId) ? standing(db, serverId, userId) : null;
    if (!me) {
      res.status(404).json({ error: "Servidor não encontrado" });
      return;
    }
    const invite = db
      .prepare("SELECT created_by, used_by, revoked_at FROM invites WHERE code = ? AND server_id = ?")
      .get(req.params.code, serverId) as { created_by: number; used_by: number | null; revoked_at: string | null } | undefined;
    if (!invite || invite.revoked_at) {
      res.status(404).json({ error: "Convite não encontrado" });
      return;
    }
    if (invite.created_by !== userId && !me.permissions.has("manage_invites")) {
      res.status(403).json({ error: "Você só pode revogar os seus convites" });
      return;
    }
    if (invite.used_by !== null) {
      res.status(400).json({ error: "Esse convite já foi usado e não pode ser revogado" });
      return;
    }
    db.prepare("UPDATE invites SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE code = ?").run(req.params.code);
    logAction(db, serverId, userId, "invite.revoked", invite.created_by === userId ? null : invite.created_by, "");
    res.status(204).end();
  });

  return router;
}
