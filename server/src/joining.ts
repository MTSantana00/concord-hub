import { logAction } from "./audit.js";
import type { Db } from "./db.js";
import { defaultRoleId } from "./roles.js";

export const DEFAULT_INVITE_LIMIT = 10;

export type Accepted = { ok: true; serverId: number; joined: boolean } | { ok: false; status: number; error: string };

/**
 * Usa um convite para a pessoa entrar no servidor. O convite vale uma vez só: quem usar primeiro o consome.
 * Quem já é membro não gasta o convite. Não abre transação: quem chama decide (para poder desfazer outras coisas junto).
 */
export function acceptInvite(db: Db, code: unknown, userId: number): Accepted {
  const invite =
    typeof code === "string"
      ? (db.prepare("SELECT server_id, created_by, used_by, revoked_at FROM invites WHERE code = ?").get(code) as
          | { server_id: number; created_by: number; used_by: number | null; revoked_at: string | null }
          | undefined)
      : undefined;
  if (!invite || invite.revoked_at) return { ok: false, status: 404, error: "Convite inválido ou expirado" };

  if (db.prepare("SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?").get(invite.server_id, userId)) {
    return { ok: false, status: 403, error: "Você foi banido deste servidor" };
  }
  if (db.prepare("SELECT 1 FROM members WHERE server_id = ? AND user_id = ?").get(invite.server_id, userId)) {
    return { ok: true, serverId: invite.server_id, joined: false };
  }

  const consumed = db
    .prepare(
      "UPDATE invites SET used_by = ?, used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE code = ? AND used_by IS NULL AND revoked_at IS NULL",
    )
    .run(userId, code as string);
  if (consumed.changes === 0) return { ok: false, status: 410, error: "Esse convite já foi usado. Peça um novo link." };

  db.prepare("INSERT INTO members (server_id, user_id, role_id) VALUES (?, ?, ?)").run(
    invite.server_id,
    userId,
    defaultRoleId(db, invite.server_id),
  );
  logAction(db, invite.server_id, userId, "invite.used", invite.created_by, "");
  return { ok: true, serverId: invite.server_id, joined: true };
}

/** Convites que a pessoa criou e ainda contam no limite: pendentes e usados (os revogados devolvem a vaga). */
export function invitesCounted(db: Db, userId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND revoked_at IS NULL").get(userId) as { n: number }).n;
}
