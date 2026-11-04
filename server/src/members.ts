import type { Db } from "./db.js";
import type { Hub } from "./hub.js";
import { PROFILE_COLUMNS, toProfile, type ProfileRow } from "./profiles.js";

export interface MemberInfo {
  id: number;
  username: string;
  online: boolean;
  isOwner: boolean;
  /** Cargo do membro (o dono não tem cargo). */
  roleId: number | null;
  roleName: string | null;
  displayName: string | null;
  about: string;
  statusKind: string;
  statusText: string;
  avatarVersion: number;
  /** Apelido neste servidor (null = usa o nome de exibição). */
  nickname: string | null;
  /** Fim do timeout, em ms desde 1970 (null = sem timeout ou já acabou). */
  timeoutUntil: number | null;
}

/** Membros do servidor em ordem alfabética, com o estado online de cada um. */
export function listMembers(db: Db, hub: Hub, serverId: number): MemberInfo[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, s.owner_id, m.nickname, m.timeout_until, m.role_id, r.name AS role_name, ${PROFILE_COLUMNS} FROM members m
       JOIN users u ON u.id = m.user_id
       JOIN servers s ON s.id = m.server_id
       LEFT JOIN roles r ON r.id = m.role_id
       WHERE m.server_id = ? ORDER BY u.username COLLATE NOCASE`,
    )
    .all(serverId) as unknown as (ProfileRow & {
    id: number;
    username: string;
    owner_id: number;
    role_id: number | null;
    role_name: string | null;
    nickname: string | null;
    timeout_until: number | null;
  })[];
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    online: hub.isOnline(r.id),
    isOwner: r.id === r.owner_id,
    roleId: r.role_id,
    roleName: r.role_name,
    nickname: r.nickname,
    timeoutUntil: r.timeout_until && r.timeout_until > Date.now() ? r.timeout_until : null,
    ...toProfile(r),
  }));
}
