import type { Db } from "./db.js";

/** Ações que vão para o log do servidor. */
export type AuditAction =
  | "invite.created"
  | "invite.revoked"
  | "invite.used"
  | "member.kicked"
  | "member.banned"
  | "voice.kicked"
  | "member.nickname_changed"
  | "channel.updated"
  | "channel.deleted"
  | "member.unbanned"
  | "member.role_changed"
  | "role.created"
  | "role.updated"
  | "role.deleted"
  | "message.deleted_by_mod"
  | "member.timeout"
  | "member.timeout_cleared";

/** Registra uma ação. `detail` é um texto curto e legível (nome do cargo, motivo etc.). */
export function logAction(db: Db, serverId: number, actorId: number | null, action: AuditAction, targetId: number | null = null, detail = "") {
  db.prepare("INSERT INTO audit_log (server_id, actor_id, action, target_id, detail) VALUES (?, ?, ?, ?, ?)").run(
    serverId,
    actorId,
    action,
    targetId,
    detail.slice(0, 200),
  );
}
