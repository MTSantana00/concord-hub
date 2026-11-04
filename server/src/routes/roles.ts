import { Router, type Response } from "express";
import { logAction } from "../audit.js";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { PERMISSIONS, parsePermissions, splitPermissions, standing, type Standing } from "../roles.js";

const MAX_ROLE_NAME = 30;

interface RoleRow {
  id: number;
  name: string;
  permissions: string;
  is_default: number;
  members: number;
}

const toRole = (r: RoleRow) => ({
  id: r.id,
  name: r.name,
  permissions: splitPermissions(r.permissions),
  isDefault: r.is_default === 1,
  members: r.members,
});

function parseName(raw: unknown): string | null {
  const name = typeof raw === "string" ? raw.trim() : "";
  return name.length >= 1 && name.length <= MAX_ROLE_NAME ? name : null;
}

/**
 * Cargos do servidor. Qualquer membro vê a lista (e as próprias permissões); só o dono cria, edita,
 * apaga cargos e atribui cargos aos membros.
 */
export function rolesRouter(db: Db, cfg: AuthConfig, hub: Hub) {
  const router = Router();
  router.use(requireAuth(cfg));

  const rolesOf = (serverId: number) =>
    (
      db
        .prepare(
          `SELECT r.id, r.name, r.permissions, r.is_default, COUNT(m.user_id) AS members
           FROM roles r LEFT JOIN members m ON m.role_id = r.id
           WHERE r.server_id = ? GROUP BY r.id ORDER BY r.is_default DESC, r.id`,
        )
        .all(serverId) as unknown as RoleRow[]
    ).map(toRole);

  const changed = (serverId: number) => hub.publishToServer(serverId, { type: "roles.changed", serverId });

  /** O que a pessoa é no servidor, ou responde 404 (não é membro). */
  function member(res: Response, serverId: number): Standing | null {
    const s = Number.isInteger(serverId) ? standing(db, serverId, res.locals.userId as number) : null;
    if (!s) res.status(404).json({ error: "Servidor não encontrado" });
    return s;
  }

  /** Só o dono passa; senão responde 404 ou 403. */
  function owner(res: Response, serverId: number): boolean {
    const s = member(res, serverId);
    if (!s) return false;
    if (!s.isOwner) {
      res.status(403).json({ error: "Só o dono do servidor pode mexer nos cargos" });
      return false;
    }
    return true;
  }

  const roleInServer = (serverId: number, roleId: number) =>
    (Number.isInteger(roleId)
      ? db.prepare("SELECT id, name, is_default FROM roles WHERE id = ? AND server_id = ?").get(roleId, serverId)
      : undefined) as { id: number; name: string; is_default: number } | undefined;

  router.get("/:id/roles", (req, res) => {
    const serverId = Number(req.params.id);
    const me = member(res, serverId);
    if (!me) return;
    res.json({
      roles: rolesOf(serverId),
      permissions: PERMISSIONS,
      me: { isOwner: me.isOwner, roleId: me.roleId, permissions: PERMISSIONS.filter((p) => me.permissions.has(p)) },
    });
  });

  router.post("/:id/roles", (req, res) => {
    const serverId = Number(req.params.id);
    if (!owner(res, serverId)) return;
    const name = parseName(req.body?.name);
    const permissions = parsePermissions(req.body?.permissions ?? []);
    if (!name || !permissions) {
      res.status(400).json({ error: `Informe um nome de 1 a ${MAX_ROLE_NAME} caracteres e permissões válidas` });
      return;
    }
    try {
      const r = db
        .prepare("INSERT INTO roles (server_id, name, permissions) VALUES (?, ?, ?)")
        .run(serverId, name, permissions.join(","));
      logAction(db, serverId, res.locals.userId as number, "role.created", null, name);
      changed(serverId);
      res.status(201).json({ role: rolesOf(serverId).find((x) => x.id === Number(r.lastInsertRowid)) });
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        res.status(409).json({ error: "Já existe um cargo com esse nome" });
        return;
      }
      throw err;
    }
  });

  router.patch("/:id/roles/:roleId", (req, res) => {
    const serverId = Number(req.params.id);
    if (!owner(res, serverId)) return;
    const role = roleInServer(serverId, Number(req.params.roleId));
    if (!role) {
      res.status(404).json({ error: "Cargo não encontrado" });
      return;
    }

    const body = req.body ?? {};
    const name = body.name === undefined ? role.name : parseName(body.name);
    const permissions = body.permissions === undefined ? undefined : parsePermissions(body.permissions);
    if (!name || permissions === null || (body.isDefault !== undefined && body.isDefault !== true)) {
      res.status(400).json({ error: "Dados do cargo inválidos" });
      return;
    }
    try {
      db.exec("BEGIN");
      db.prepare("UPDATE roles SET name = ? WHERE id = ?").run(name, role.id);
      if (permissions) db.prepare("UPDATE roles SET permissions = ? WHERE id = ?").run(permissions.join(","), role.id);
      if (body.isDefault === true) {
        db.prepare("UPDATE roles SET is_default = 0 WHERE server_id = ?").run(serverId);
        db.prepare("UPDATE roles SET is_default = 1 WHERE id = ?").run(role.id);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        res.status(409).json({ error: "Já existe um cargo com esse nome" });
        return;
      }
      throw err;
    }
    logAction(db, serverId, res.locals.userId as number, "role.updated", null, name);
    changed(serverId);
    res.json({ role: rolesOf(serverId).find((x) => x.id === role.id) });
  });

  router.delete("/:id/roles/:roleId", (req, res) => {
    const serverId = Number(req.params.id);
    if (!owner(res, serverId)) return;
    const role = roleInServer(serverId, Number(req.params.roleId));
    if (!role) {
      res.status(404).json({ error: "Cargo não encontrado" });
      return;
    }
    if (role.is_default === 1) {
      res.status(400).json({ error: "O cargo padrão não pode ser apagado. Torne outro cargo padrão primeiro." });
      return;
    }
    const padrao = db.prepare("SELECT id FROM roles WHERE server_id = ? AND is_default = 1").get(serverId) as { id: number };
    db.prepare("UPDATE members SET role_id = ? WHERE role_id = ?").run(padrao.id, role.id);
    db.prepare("DELETE FROM roles WHERE id = ?").run(role.id);
    logAction(db, serverId, res.locals.userId as number, "role.deleted", null, role.name);
    changed(serverId);
    res.status(204).end();
  });

  router.put("/:id/members/:userId/role", (req, res) => {
    const serverId = Number(req.params.id);
    if (!owner(res, serverId)) return;
    const targetId = Number(req.params.userId);
    const target = Number.isInteger(targetId) ? standing(db, serverId, targetId) : null;
    if (!target) {
      res.status(404).json({ error: "Membro não encontrado" });
      return;
    }
    if (target.isOwner) {
      res.status(400).json({ error: "O dono do servidor não tem cargo" });
      return;
    }
    const role = roleInServer(serverId, Number(req.body?.roleId));
    if (!role) {
      res.status(400).json({ error: "Cargo inválido" });
      return;
    }
    db.prepare("UPDATE members SET role_id = ? WHERE server_id = ? AND user_id = ?").run(role.id, serverId, targetId);
    logAction(db, serverId, res.locals.userId as number, "member.role_changed", targetId, role.name);
    changed(serverId);
    res.json({ roleId: role.id });
  });

  return router;
}
