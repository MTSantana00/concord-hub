import type { Db } from "./db.js";

/** Tudo o que um cargo pode permitir. O dono do servidor tem todas, sempre. */
export const PERMISSIONS = ["invite", "manage_invites", "manage_messages", "kick_ban", "manage_channels", "view_log"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Cargos criados em todo servidor novo (e nos servidores que já existiam, na migração). */
const STARTER_ROLES: { name: string; permissions: Permission[]; isDefault: boolean }[] = [
  { name: "Membro", permissions: [], isDefault: true },
  { name: "Convidador", permissions: ["invite"], isDefault: false },
  { name: "Moderador", permissions: [...PERMISSIONS], isDefault: false },
];

/** Cria os cargos iniciais do servidor e devolve o id do cargo padrão. */
export function seedRoles(db: Db, serverId: number): number {
  let defaultId = 0;
  for (const r of STARTER_ROLES) {
    const result = db
      .prepare("INSERT INTO roles (server_id, name, permissions, is_default) VALUES (?, ?, ?, ?)")
      .run(serverId, r.name, r.permissions.join(","), r.isDefault ? 1 : 0);
    if (r.isDefault) defaultId = Number(result.lastInsertRowid);
  }
  return defaultId;
}

export function defaultRoleId(db: Db, serverId: number): number | null {
  const row = db.prepare("SELECT id FROM roles WHERE server_id = ? AND is_default = 1").get(serverId) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

/** Lista de permissões vinda do cliente: só nomes conhecidos, sem repetir; null se tiver algo inválido. */
export function parsePermissions(raw: unknown): Permission[] | null {
  if (!Array.isArray(raw)) return null;
  const out = new Set<Permission>();
  for (const p of raw) {
    if (typeof p !== "string" || !(PERMISSIONS as readonly string[]).includes(p)) return null;
    out.add(p as Permission);
  }
  return PERMISSIONS.filter((p) => out.has(p));
}

export const splitPermissions = (stored: string): Permission[] =>
  PERMISSIONS.filter((p) => stored.split(",").includes(p));

export interface Standing {
  isOwner: boolean;
  roleId: number | null;
  permissions: Set<Permission>;
}

/** O que a pessoa pode neste servidor; null se ela não for membro. */
export function standing(db: Db, serverId: number, userId: number): Standing | null {
  const row = db
    .prepare(
      `SELECT s.owner_id, m.role_id, r.permissions FROM members m
       JOIN servers s ON s.id = m.server_id
       LEFT JOIN roles r ON r.id = m.role_id
       WHERE m.server_id = ? AND m.user_id = ?`,
    )
    .get(serverId, userId) as { owner_id: number; role_id: number | null; permissions: string | null } | undefined;
  if (!row) return null;
  const isOwner = row.owner_id === userId;
  return {
    isOwner,
    roleId: row.role_id,
    permissions: new Set(isOwner ? PERMISSIONS : splitPermissions(row.permissions ?? "")),
  };
}

export function can(db: Db, serverId: number, userId: number, permission: Permission): boolean {
  return standing(db, serverId, userId)?.permissions.has(permission) ?? false;
}
