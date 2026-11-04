import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { Router } from "express";
import { COOKIE_NAME, cookieOptions, requireAuth, signToken, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { acceptInvite } from "../joining.js";
import { listMembers } from "../members.js";
import { PROFILE_COLUMNS, toProfile, type ProfileRow } from "../profiles.js";
import { normalizeEmail, type MailService } from "../mail.js";
import { emailState } from "./email.js";

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72; // limite do bcrypt

// Hash falso para o login gastar o mesmo tempo quando o usuário não existe
const DUMMY_HASH = bcrypt.hashSync("senha-falsa-para-tempo-constante", 10);

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  token_version: number;
  must_change_password: number;
}

export function authRouter(db: Db, cfg: AuthConfig, hub: Hub, inviteOnly = false, setupCode?: string, mail: MailService | null = null) {
  const router = Router();
  const profileOf = (userId: number) => toProfile(db.prepare(`SELECT ${PROFILE_COLUMNS} FROM users u WHERE u.id = ?`).get(userId) as unknown as ProfileRow);
  const emailOf = (userId: number) => emailState(db, mail, userId);
  const isAdmin = (userId: number) => (db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId) as { is_admin: number } | undefined)?.is_admin === 1;

  router.post("/register", async (req, res) => {
    const { username, password, inviteCode } = req.body ?? {};
    // com envio de e-mail ligado, a conta nova precisa de um e-mail (confirmado logo depois com um código)
    const email = mail?.enabled ? normalizeEmail(req.body?.email) : null;
    const invite =
      typeof inviteCode === "string"
        ? (db.prepare("SELECT used_by, revoked_at FROM invites WHERE code = ?").get(inviteCode) as
            | { used_by: number | null; revoked_at: string | null }
            | undefined)
        : undefined;
    const usableInvite = !!invite && invite.used_by === null && !invite.revoked_at;
    const firstAccount = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n === 0;

    // Servidor fechado: só cria conta quem veio por um convite que ainda vale
    if (inviteOnly) {
      const setup = firstAccount && !!setupCode && inviteCode === setupCode; // primeira conta (o dono): código secreto
      if (!usableInvite && !setup) {
        if (invite?.used_by != null) {
          res.status(410).json({ error: "Esse convite já foi usado. Peça um novo link a quem te convidou." });
        } else {
          res.status(403).json({ error: "O cadastro é só por convite. Peça um link de convite a um amigo." });
        }
        return;
      }
    }
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      res.status(400).json({ error: "Usuário deve ter 3 a 20 letras, números ou _" });
      return;
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      res.status(400).json({ error: `Senha deve ter de ${MIN_PASSWORD} a ${MAX_PASSWORD} caracteres` });
      return;
    }

    if (mail?.enabled) {
      if (!email) {
        res.status(400).json({ error: "Informe um e-mail válido. Ele serve para recuperar a conta." });
        return;
      }
      if (db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
        res.status(409).json({ error: "Esse e-mail já está em uso por outra conta." });
        return;
      }
    }

    const hash = await bcrypt.hash(password, 10);
    let id: number;
    let joinedServer: number | null = null;
    db.exec("BEGIN");
    try {
      const result = db
        .prepare("INSERT INTO users (username, password_hash, is_admin, email_required) VALUES (?, ?, ?, ?)")
        .run(username, hash, firstAccount ? 1 : 0, mail?.enabled ? 1 : 0);
      id = Number(result.lastInsertRowid);
      // O convite é gasto junto com a criação da conta: se alguém o usou no meio do caminho, nada fica pela metade
      if (usableInvite) {
        const accepted = acceptInvite(db, inviteCode, id);
        if (!accepted.ok) {
          db.exec("ROLLBACK");
          res.status(accepted.status).json({ error: accepted.error });
          return;
        }
        joinedServer = accepted.serverId;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        res.status(409).json({ error: "Esse usuário já existe" });
        return;
      }
      throw err;
    }

    if (joinedServer !== null) {
      const member = listMembers(db, hub, joinedServer).find((m) => m.id === id);
      hub.publishToServer(joinedServer, { type: "member.joined", serverId: joinedServer, member });
    }
    // o código de confirmação sai logo; se o envio falhar a conta já existe e a tela pede para reenviar
    if (mail?.enabled && email) await mail.sendCode("verify", id, email, username);
    res.cookie(COOKIE_NAME, signToken(cfg, id), cookieOptions(cfg));
    res.status(201).json({ user: { id, username, isAdmin: firstAccount, mustChangePassword: false, ...profileOf(id), ...emailOf(id) } });
  });

  router.post("/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Informe usuário e senha" });
      return;
    }

    const row = db
      .prepare("SELECT id, username, password_hash, token_version, must_change_password FROM users WHERE username = ?")
      .get(username) as UserRow | undefined;
    const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) {
      res.status(401).json({ error: "Usuário ou senha inválidos" });
      return;
    }

    res.cookie(COOKIE_NAME, signToken(cfg, row.id, row.token_version), cookieOptions(cfg));
    res.json({ user: { id: row.id, username: row.username, isAdmin: isAdmin(row.id), mustChangePassword: row.must_change_password === 1, ...profileOf(row.id), ...emailOf(row.id) } });
  });

  router.post("/logout", (_req, res) => {
    const { maxAge: _maxAge, ...clearOptions } = cookieOptions(cfg);
    res.clearCookie(COOKIE_NAME, clearOptions);
    res.status(204).end();
  });

  router.get("/me", requireAuth(cfg), (_req, res) => {
    const row = db
      .prepare("SELECT id, username, is_admin, must_change_password FROM users WHERE id = ?")
      .get(res.locals.userId) as { id: number; username: string; is_admin: number; must_change_password: number } | undefined;
    if (!row) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    res.json({ user: { id: row.id, username: row.username, isAdmin: row.is_admin === 1, mustChangePassword: row.must_change_password === 1, ...profileOf(row.id), ...emailOf(row.id) } });
  });

  /** Trocar a própria senha: pede a atual, derruba os outros aparelhos e mantém este logado. */
  router.post("/password", requireAuth(cfg), async (req, res) => {
    const userId = res.locals.userId as number;
    const { current, next } = req.body ?? {};
    if (typeof current !== "string" || typeof next !== "string") {
      res.status(400).json({ error: "Informe a senha atual e a nova" });
      return;
    }
    if (next.length < MIN_PASSWORD || next.length > MAX_PASSWORD) {
      res.status(400).json({ error: `A nova senha deve ter de ${MIN_PASSWORD} a ${MAX_PASSWORD} caracteres` });
      return;
    }
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string };
    if (!(await bcrypt.compare(current, row.password_hash))) {
      res.status(403).json({ error: "A senha atual está errada" });
      return;
    }
    if (current === next) {
      res.status(400).json({ error: "A nova senha precisa ser diferente da atual" });
      return;
    }
    const hash = await bcrypt.hash(next, 10);
    db.prepare("UPDATE users SET password_hash = ?, token_version = token_version + 1, must_change_password = 0 WHERE id = ?").run(hash, userId);
    const { token_version } = db.prepare("SELECT token_version FROM users WHERE id = ?").get(userId) as { token_version: number };
    res.cookie(COOKIE_NAME, signToken(cfg, userId, token_version), cookieOptions(cfg));
    res.status(204).end();
  });

  /** "Sair de todos os aparelhos": derruba todos os logins, menos o deste aparelho. */
  router.post("/logout-all", requireAuth(cfg), (_req, res) => {
    const userId = res.locals.userId as number;
    db.prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run(userId);
    const { token_version } = db.prepare("SELECT token_version FROM users WHERE id = ?").get(userId) as { token_version: number };
    res.cookie(COOKIE_NAME, signToken(cfg, userId, token_version), cookieOptions(cfg));
    res.status(204).end();
  });

  /** Só a administradora da plataforma: gera uma senha temporária (mostrada uma vez) para um amigo que esqueceu a dele. */
  router.post("/admin/reset-password", requireAuth(cfg), async (req, res) => {
    const adminId = res.locals.userId as number;
    if (!isAdmin(adminId)) {
      res.status(403).json({ error: "Só a administradora da plataforma pode redefinir senhas" });
      return;
    }
    const targetId = Number(req.body?.userId);
    const target = Number.isInteger(targetId)
      ? (db.prepare("SELECT id, username FROM users WHERE id = ?").get(targetId) as { id: number; username: string } | undefined)
      : undefined;
    if (!target) {
      res.status(404).json({ error: "Usuário não encontrado" });
      return;
    }
    if (target.id === adminId) {
      res.status(400).json({ error: "Para trocar a sua própria senha use a tela da conta" });
      return;
    }
    const tempPassword = randomBytes(9).toString("base64url");
    const hash = await bcrypt.hash(tempPassword, 10);
    db.prepare("UPDATE users SET password_hash = ?, token_version = token_version + 1, must_change_password = 1 WHERE id = ?").run(hash, target.id);
    res.json({ username: target.username, tempPassword });
  });

  return router;
}
