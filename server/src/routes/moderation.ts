import { Router, type Response } from "express";
import { logAction, type AuditAction } from "../audit.js";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { MAX_TIMEOUT_MINUTES } from "../channelAccess.js";
import { standing, type Standing } from "../roles.js";

const MAX_REASON = 200;

/** Texto legível de cada ação do log. */
const ACTION_TEXT: Record<AuditAction, string> = {
  "invite.created": "criou um convite",
  "invite.revoked": "revogou um convite",
  "invite.used": "entrou com o convite de",
  "member.kicked": "expulsou",
  "member.banned": "baniu",
  "voice.kicked": "tirou da sala de voz",
  "member.nickname_changed": "mudou o apelido de",
  "channel.updated": "alterou o canal",
  "channel.deleted": "apagou o canal",
  "member.unbanned": "desbaniu",
  "member.role_changed": "mudou o cargo de",
  "role.created": "criou o cargo",
  "role.updated": "editou o cargo",
  "role.deleted": "apagou o cargo",
  "message.deleted_by_mod": "apagou uma mensagem de",
  "member.timeout": "deixou em timeout",
  "member.timeout_cleared": "tirou do timeout",
};

/**
 * Moderação do servidor: expulsar, banir e desbanir, sair do servidor e ver o log de ações.
 * Ninguém age sobre o dono; quem tem kick_ban não age sobre outro com kick_ban (só o dono faz isso).
 */
export function moderationRouter(db: Db, cfg: AuthConfig, hub: Hub) {
  const router = Router();
  router.use(requireAuth(cfg));

  function member(res: Response, serverId: number): Standing | null {
    const s = Number.isInteger(serverId) ? standing(db, serverId, res.locals.userId as number) : null;
    if (!s) res.status(404).json({ error: "Servidor não encontrado" });
    return s;
  }

  /** Confere se quem age pode agir sobre o alvo; responde o erro e devolve false se não. */
  function canAct(res: Response, serverId: number, me: Standing, targetId: number, owner = "O dono do servidor não pode ser expulso nem banido"): boolean {
    if (!me.permissions.has("kick_ban")) {
      res.status(403).json({ error: "Seu cargo não pode expulsar nem banir" });
      return false;
    }
    const target = Number.isInteger(targetId) ? standing(db, serverId, targetId) : null;
    if (!target) {
      res.status(404).json({ error: "Membro não encontrado" });
      return false;
    }
    if (targetId === (res.locals.userId as number)) {
      res.status(400).json({ error: "Você não pode fazer isso consigo mesmo" });
      return false;
    }
    if (target.isOwner) {
      res.status(403).json({ error: owner });
      return false;
    }
    if (!me.isOwner && target.permissions.has("kick_ban")) {
      res.status(403).json({ error: "Só o dono pode agir sobre quem também modera" });
      return false;
    }
    return true;
  }

  /** Tira a pessoa do servidor e avisa todo mundo (inclusive ela). */
  function remove(serverId: number, userId: number, reason: "kicked" | "banned" | "left") {
    db.prepare("DELETE FROM members WHERE server_id = ? AND user_id = ?").run(serverId, userId);
    hub.voice.removeFromServer(userId, serverId);
    const event = { type: "member.removed", serverId, userId, reason };
    hub.publishToServer(serverId, event);
    hub.publishToUsers([userId], event);
  }

  /** Quem pode expulsar também define ou limpa o apelido de outro membro (mesmas regras de hierarquia). */
  router.put("/:id/members/:userId/nickname", (req, res) => {
    const serverId = Number(req.params.id);
    const me = member(res, serverId);
    if (!me) return;
    const targetId = Number(req.params.userId);
    if (!canAct(res, serverId, me, targetId, "O dono do servidor define o próprio apelido")) return;
    const raw = req.body?.nickname;
    const cleaned = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, "").trim() : null; // eslint-disable-line no-control-regex
    if (raw !== null && raw !== undefined && (typeof raw !== "string" || cleaned!.length > 32)) {
      res.status(400).json({ error: "O apelido deve ter até 32 caracteres" });
      return;
    }
    const nickname = cleaned ? cleaned : null;
    db.prepare("UPDATE members SET nickname = ? WHERE server_id = ? AND user_id = ?").run(nickname, serverId, targetId);
    hub.publishToServer(serverId, { type: "member.updated", serverId, userId: targetId, nickname });
    logAction(db, serverId, res.locals.userId as number, "member.nickname_changed", targetId, nickname ?? "(removido)");
    res.json({ nickname });
  });

  /** Timeout: a pessoa continua no servidor, mas não envia nada até acabar. `minutes` 0 (ou ausente) tira o timeout. */
  router.put("/:id/members/:userId/timeout", (req, res) => {
    const serverId = Number(req.params.id);
    const me = member(res, serverId);
    if (!me) return;
    const targetId = Number(req.params.userId);
    if (!canAct(res, serverId, me, targetId, "O dono do servidor não pode ficar em timeout")) return;
    const raw = req.body?.minutes ?? 0;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_TIMEOUT_MINUTES) {
      res.status(400).json({ error: `O timeout deve ter de 1 minuto a ${MAX_TIMEOUT_MINUTES / 1440} dias (0 tira o timeout)` });
      return;
    }
    const until = raw === 0 ? null : Date.now() + raw * 60_000;
    db.prepare("UPDATE members SET timeout_until = ? WHERE server_id = ? AND user_id = ?").run(until, serverId, targetId);
    hub.publishToServer(serverId, { type: "member.timeout", serverId, userId: targetId, timeoutUntil: until });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, MAX_REASON) : "";
    logAction(db, serverId, res.locals.userId as number, until === null ? "member.timeout_cleared" : "member.timeout", targetId, until === null ? "" : [`${raw} min`, reason].filter(Boolean).join(": "));
    res.json({ timeoutUntil: until });
  });

  router.delete("/:id/members/:userId", (req, res) => {
    const serverId = Number(req.params.id);
    const me = member(res, serverId);
    if (!me) return;
    const targetId = Number(req.params.userId);
    if (!canAct(res, serverId, me, targetId)) return;
    remove(serverId, targetId, "kicked");
    logAction(db, serverId, res.locals.userId as number, "member.kicked", targetId);
    res.status(204).end();
  });

  router.post("/:id/bans", (req, res) => {
    const serverId = Number(req.params.id);
    const me = member(res, serverId);
    if (!me) return;
    const targetId = Number(req.body?.userId);
    if (!canAct(res, serverId, me, targetId)) return;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, MAX_REASON) : "";
    db.exec("BEGIN");
    try {
      db.prepare("INSERT OR REPLACE INTO bans (server_id, user_id, banned_by) VALUES (?, ?, ?)").run(
        serverId,
        targetId,
        res.locals.userId,
      );
      remove(serverId, targetId, "banned");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    logAction(db, serverId, res.locals.userId as number, "member.banned", targetId, reason);
    res.status(201).json({ ok: true });
  });

  router.get("/:id/bans", (req, res) => {
    const serverId = Number(req.params.id);
    const me = member(res, serverId);
    if (!me) return;
    if (!me.permissions.has("kick_ban")) {
      res.status(403).json({ error: "Seu cargo não pode ver os banidos" });
      return;
    }
    const rows = db
      .prepare(
        `SELECT b.user_id, u.username, b.created_at, a.username AS banned_by FROM bans b
         JOIN users u ON u.id = b.user_id LEFT JOIN users a ON a.id = b.banned_by
         WHERE b.server_id = ? ORDER BY b.created_at DESC`,
      )
      .all(serverId) as { user_id: number; username: string; created_at: string; banned_by: string | null }[];
    res.json({ bans: rows.map((r) => ({ userId: r.user_id, username: r.username, createdAt: r.created_at, bannedBy: r.banned_by })) });
  });

  router.delete("/:id/bans/:userId", (req, res) => {
    const serverId = Number(req.params.id);
    const me = member(res, serverId);
    if (!me) return;
    if (!me.permissions.has("kick_ban")) {
      res.status(403).json({ error: "Seu cargo não pode desbanir" });
      return;
    }
    const targetId = Number(req.params.userId);
    const result = db.prepare("DELETE FROM bans WHERE server_id = ? AND user_id = ?").run(serverId, targetId);
    if (result.changes === 0) {
      res.status(404).json({ error: "Essa pessoa não está banida" });
      return;
    }
    logAction(db, serverId, res.locals.userId as number, "member.unbanned", targetId);
    res.status(204).end();
  });

  /** Sair do servidor por conta própria (o dono não pode: o servidor ficaria sem dono). */
  router.post("/:id/leave", (req, res) => {
    const serverId = Number(req.params.id);
    const me = member(res, serverId);
    if (!me) return;
    if (me.isOwner) {
      res.status(400).json({ error: "O dono não pode sair do próprio servidor" });
      return;
    }
    remove(serverId, res.locals.userId as number, "left");
    res.status(204).end();
  });

  router.get("/:id/log", (req, res) => {
    const serverId = Number(req.params.id);
    const me = member(res, serverId);
    if (!me) return;
    if (!me.permissions.has("view_log")) {
      res.status(403).json({ error: "Seu cargo não pode ver o log" });
      return;
    }
    const rows = db
      .prepare(
        `SELECT l.id, l.action, l.detail, l.created_at, a.username AS actor, t.username AS target FROM audit_log l
         LEFT JOIN users a ON a.id = l.actor_id LEFT JOIN users t ON t.id = l.target_id
         WHERE l.server_id = ? ORDER BY l.id DESC LIMIT 100`,
      )
      .all(serverId) as { id: number; action: AuditAction; detail: string; created_at: string; actor: string | null; target: string | null }[];
    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actor,
        target: r.target,
        detail: r.detail,
        createdAt: r.created_at,
        text: [
          r.actor ?? "(conta removida)",
          r.action === "invite.revoked" && r.target ? "revogou o convite de" : (ACTION_TEXT[r.action] ?? r.action),
          r.target,
          r.detail && `(${r.detail})`,
        ]
          .filter(Boolean)
          .join(" "),
      })),
    });
  });

  return router;
}
