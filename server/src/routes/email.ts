import bcrypt from "bcryptjs";
import { Router, type RequestHandler } from "express";
import { COOKIE_NAME, cookieOptions, requireAuth, signToken, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import { MailService, normalizeEmail, templates } from "../mail.js";

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72;

/** O que o cliente precisa saber do e-mail da conta (o e-mail só existe aqui depois de confirmado). */
export function emailState(db: Db, mail: MailService | null, userId: number) {
  const row = db.prepare("SELECT email, email_required FROM users WHERE id = ?").get(userId) as { email: string | null; email_required: number } | undefined;
  const verified = !!row?.email;
  const pending = !!mail?.enabled && row?.email_required === 1 && !verified;
  // para onde foi o último código: a tela de confirmação já mostra o e-mail do cadastro
  const sentTo = pending ? (db.prepare("SELECT email FROM email_codes WHERE user_id = ? AND purpose = 'verify' ORDER BY id DESC LIMIT 1").get(userId) as { email: string } | undefined) : undefined;
  return { email: row?.email ?? null, emailVerified: verified, emailPending: pending, pendingEmail: sentTo?.email ?? null };
}

/** Confirmar o e-mail da conta e recuperar a senha por código. Sem envio de e-mail configurado, tudo isso fica desligado. */
export function emailRouter(db: Db, cfg: AuthConfig, mail: MailService) {
  const router = Router();
  const auth = requireAuth(cfg);

  /** A tela de entrada usa isto para mostrar (ou não) "Esqueci a senha" e o campo de e-mail do cadastro. */
  router.get("/mail", (_req, res) => {
    res.json({ enabled: mail.enabled });
  });

  // só nas rotas daqui: este roteador divide o /api/auth com o de login e cadastro
  const needMail: RequestHandler = (_req, res, next) => {
    if (mail.enabled) return next();
    res.status(503).json({ error: "O envio de e-mail não está ligado neste servidor." });
  };

  /** Manda o código para confirmar um e-mail (o do cadastro ou um novo). */
  router.post("/email/send-code", needMail, auth, async (req, res) => {
    const userId = res.locals.userId as number;
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      res.status(400).json({ error: "Informe um e-mail válido." });
      return;
    }
    const taken = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?").get(email, userId);
    if (taken) {
      res.status(409).json({ error: "Esse e-mail já está em uso por outra conta." });
      return;
    }
    const { username } = db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string };
    const sent = await mail.sendCode("verify", userId, email, username);
    if (!sent.ok) {
      res.status(sent.status).json({ error: sent.error });
      return;
    }
    res.status(204).end();
  });

  /** Confere o código: o e-mail passa a valer na conta e, na primeira vez, chega o e-mail de boas-vindas. */
  router.post("/email/verify", needMail, auth, async (req, res) => {
    const userId = res.locals.userId as number;
    const checked = mail.checkCode("verify", userId, req.body?.code);
    if (!checked.ok) {
      res.status(checked.status).json({ error: checked.error });
      return;
    }
    const before = db.prepare("SELECT username, email FROM users WHERE id = ?").get(userId) as { username: string; email: string | null };
    try {
      db.prepare("UPDATE users SET email = ?, email_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(checked.email, userId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        res.status(409).json({ error: "Esse e-mail já está em uso por outra conta." });
        return;
      }
      throw err;
    }
    if (!before.email) void mail.notify(checked.email, mail.welcome(before.username));
    res.json(emailState(db, mail, userId));
  });

  /** "Esqueci a senha": manda um código para o e-mail confirmado. A resposta é sempre a mesma, exista a conta ou não. */
  router.post("/forgot", needMail, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      res.status(400).json({ error: "Informe um e-mail válido." });
      return;
    }
    const user = db.prepare("SELECT id, username FROM users WHERE email = ? COLLATE NOCASE").get(email) as { id: number; username: string } | undefined;
    if (user) await mail.sendCode("reset", user.id, email, user.username); // erro de envio/intervalo não vaza se a conta existe
    res.status(204).end();
  });

  /** Troca a senha com o código recebido; derruba os logins antigos e avisa por e-mail. */
  router.post("/reset", needMail, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!email) {
      res.status(400).json({ error: "Informe um e-mail válido." });
      return;
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      res.status(400).json({ error: `A nova senha deve ter de ${MIN_PASSWORD} a ${MAX_PASSWORD} caracteres` });
      return;
    }
    const user = db.prepare("SELECT id, username FROM users WHERE email = ? COLLATE NOCASE").get(email) as { id: number; username: string } | undefined;
    const checked = user ? mail.checkCode("reset", user.id, req.body?.code) : null;
    if (!user || !checked) {
      res.status(400).json({ error: "Código errado ou vencido." });
      return;
    }
    if (!checked.ok) {
      res.status(checked.status).json({ error: checked.error });
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    db.prepare("UPDATE users SET password_hash = ?, token_version = token_version + 1, must_change_password = 0 WHERE id = ?").run(hash, user.id);
    void mail.notify(email, templates.passwordChanged(user.username));
    // entrar já com a senha nova: quem recuperou a conta não precisa digitar tudo de novo
    const { token_version } = db.prepare("SELECT token_version FROM users WHERE id = ?").get(user.id) as { token_version: number };
    res.cookie(COOKIE_NAME, signToken(cfg, user.id, token_version), cookieOptions(cfg));
    res.status(204).end();
  });

  return router;
}
