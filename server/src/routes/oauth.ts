import { timingSafeEqual } from "node:crypto";
import { Router, type CookieOptions, type Response } from "express";
import jwt from "jsonwebtoken";
import { COOKIE_NAME, cookieOptions, requireAuth, signToken, userIdFromToken, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { acceptInvite } from "../joining.js";
import { listMembers } from "../members.js";
import { PROVIDER_NAMES, challengeOf, randomToken, type ProviderName, type Providers } from "../oauth.js";
import { PROFILE_COLUMNS, toProfile, type ProfileRow } from "../profiles.js";

const FLOW_COOKIE = "concord_oauth";
const PENDING_COOKIE = "concord_pending";
const FLOW_SECONDS = 10 * 60;
const PENDING_SECONDS = 15 * 60;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const INVITE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NO_PASSWORD = "!"; // marcador que nunca confere com bcrypt: conta criada pelo Google/GitHub não tem senha

export interface OAuthDeps {
  providers: Providers;
  /** Endereço público do app (https://...), de onde saem os endereços de retorno. Sem ele nada liga. */
  publicUrl: string | null;
  inviteOnly: boolean;
  setupCode?: string;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Entrar com Google ou GitHub. O convite continua sendo a porta: quem nunca foi convidado e não tem conta é barrado.
 * A identidade é (provedor, id do provedor); nunca vinculamos contas pelo e-mail.
 */
export function oauthRouter(db: Db, cfg: AuthConfig, hub: Hub, deps: OAuthDeps) {
  const router = Router();
  const { providers, publicUrl, inviteOnly, setupCode } = deps;
  const profileOf = (userId: number) => toProfile(db.prepare(`SELECT ${PROFILE_COLUMNS} FROM users u WHERE u.id = ?`).get(userId) as unknown as ProfileRow);
  const usersCount = () => (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;

  const flowCookie = (seconds: number): CookieOptions => ({ httpOnly: true, sameSite: "lax", secure: cfg.secureCookies, path: "/api/auth/oauth", maxAge: seconds * 1000 });
  const clear = (res: Response, name: string) => {
    const { maxAge: _m, ...o } = flowCookie(0);
    res.clearCookie(name, o);
  };
  const sign = (payload: object, seconds: number) => jwt.sign(payload, cfg.jwtSecret, { expiresIn: seconds, algorithm: "HS256" });
  const read = (token: unknown, purpose: string): Record<string, any> | null => {
    if (typeof token !== "string") return null;
    try {
      const p = jwt.verify(token, cfg.jwtSecret, { algorithms: ["HS256"] }) as Record<string, any>;
      return p.pur === purpose ? p : null;
    } catch {
      return null;
    }
  };
  const go = (res: Response, query: string) => res.redirect(302, `/${query}`);

  const usableInvite = (code: unknown) => {
    if (typeof code !== "string") return false;
    const row = db.prepare("SELECT used_by, revoked_at FROM invites WHERE code = ?").get(code) as { used_by: number | null; revoked_at: string | null } | undefined;
    return !!row && row.used_by === null && !row.revoked_at;
  };
  /** Pode criar conta com este convite (ou o código secreto da primeira conta, ou sem nada se o servidor é aberto)? */
  const signupAllowed = (invite: unknown) => !inviteOnly || usableInvite(invite) || (usersCount() === 0 && !!setupCode && invite === setupCode);

  function startSession(res: Response, userId: number) {
    const row = db.prepare("SELECT token_version FROM users WHERE id = ?").get(userId) as { token_version: number };
    res.cookie(COOKIE_NAME, signToken(cfg, userId, row.token_version), cookieOptions(cfg));
  }

  router.get("/providers", (_req, res) => {
    res.json({ google: !!providers.google && !!publicUrl, github: !!providers.github && !!publicUrl });
  });

  // ---------------------------------------------------------------- 1) ir ao provedor
  router.get("/:provider/start", (req, res) => {
    const provider = providers[req.params.provider as ProviderName];
    if (!provider || !publicUrl) return go(res, "?oauth_erro=indisponivel");
    const mode = req.query.mode === "link" ? "link" : "login";
    let uid: number | null = null;
    if (mode === "link") {
      uid = userIdFromToken(cfg, req.cookies?.[COOKIE_NAME]);
      if (uid === null) return go(res, "?oauth_erro=sem-login");
    }
    const invite = typeof req.query.invite === "string" && INVITE_RE.test(req.query.invite) ? req.query.invite : null;
    const state = randomToken();
    const verifier = randomToken();
    res.cookie(FLOW_COOKIE, sign({ pur: "oauth", st: state, v: verifier, p: provider.name, inv: invite, mode, uid }, FLOW_SECONDS), flowCookie(FLOW_SECONDS));
    res.redirect(302, provider.authorizeUrl({ state, challenge: challengeOf(verifier), redirectUri: `${publicUrl}/api/auth/oauth/${provider.name}/callback` }));
  });

  // ---------------------------------------------------------------- 2) volta do provedor
  router.get("/:provider/callback", async (req, res) => {
    const provider = providers[req.params.provider as ProviderName];
    const flow = read(req.cookies?.[FLOW_COOKIE], "oauth");
    clear(res, FLOW_COOKIE); // vale uma vez só
    const state = req.query.state;
    if (!provider || !publicUrl || !flow || flow.p !== provider.name || typeof state !== "string" || !same(state, String(flow.st))) {
      return go(res, "?oauth_erro=expirou");
    }
    if (req.query.error || typeof req.query.code !== "string") return go(res, "?oauth_erro=cancelado");

    let profile;
    try {
      profile = await provider.exchange({ code: req.query.code, verifier: String(flow.v), redirectUri: `${publicUrl}/api/auth/oauth/${provider.name}/callback` });
    } catch {
      return go(res, "?oauth_erro=falhou");
    }
    const existing = db.prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?").get(provider.name, profile.subject) as { user_id: number } | undefined;

    if (flow.mode === "link") {
      const me = userIdFromToken(cfg, req.cookies?.[COOKIE_NAME]);
      if (me === null || me !== flow.uid) return go(res, "?oauth_erro=sem-login");
      if (existing) return go(res, existing.user_id === me ? "?oauth_ok=vinculado" : "?oauth_erro=ja-vinculada");
      if (db.prepare("SELECT 1 FROM identities WHERE user_id = ? AND provider = ?").get(me, provider.name)) return go(res, "?oauth_erro=ja-tem");
      db.prepare("INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)").run(provider.name, profile.subject, me);
      return go(res, "?oauth_ok=vinculado");
    }

    if (existing) {
      startSession(res, existing.user_id);
      // Quem já tem conta e chegou por um link de convite entra no servidor também (se o convite ainda vale)
      if (typeof flow.inv === "string" && usableInvite(flow.inv)) {
        const accepted = acceptInvite(db, flow.inv, existing.user_id);
        if (accepted.ok && accepted.joined) {
          const member = listMembers(db, hub, accepted.serverId).find((m) => m.id === existing.user_id);
          hub.publishToServer(accepted.serverId, { type: "member.joined", serverId: accepted.serverId, member });
        }
      }
      return go(res, "");
    }
    if (!signupAllowed(flow.inv)) return go(res, "?oauth_erro=sem-convite");
    res.cookie(PENDING_COOKIE, sign({ pur: "pending", p: provider.name, sub: profile.subject, nick: profile.suggestedNick, inv: flow.inv ?? null }, PENDING_SECONDS), flowCookie(PENDING_SECONDS));
    return go(res, "?oauth=apelido");
  });

  // ---------------------------------------------------------------- 3) escolher o apelido
  router.get("/pending", (req, res) => {
    const p = read(req.cookies?.[PENDING_COOKIE], "pending");
    if (!p) {
      res.status(404).json({ error: "O cadastro expirou. Entre de novo." });
      return;
    }
    res.json({ provider: p.p, suggestedNick: p.nick });
  });

  router.post("/complete", (req, res) => {
    const p = read(req.cookies?.[PENDING_COOKIE], "pending");
    if (!p || !(PROVIDER_NAMES as string[]).includes(p.p)) {
      res.status(410).json({ error: "O cadastro expirou. Entre de novo com o Google ou o GitHub." });
      return;
    }
    const username = req.body?.username;
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      res.status(400).json({ error: "O apelido deve ter 3 a 20 letras, números ou _" });
      return;
    }
    if (!signupAllowed(p.inv)) {
      res.status(403).json({ error: "O cadastro é só por convite. Peça um link de convite a um amigo." });
      return;
    }
    const firstAccount = usersCount() === 0;
    let id: number;
    let joinedServer: number | null = null;
    db.exec("BEGIN");
    try {
      id = Number(db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)").run(username, NO_PASSWORD, firstAccount ? 1 : 0).lastInsertRowid);
      db.prepare("INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)").run(p.p, p.sub, id);
      if (usableInvite(p.inv)) {
        const accepted = acceptInvite(db, p.inv, id);
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
        const identityTaken = err.message.includes("identities");
        res.status(409).json({ error: identityTaken ? "Essa conta já tem cadastro. Entre com ela." : "Esse apelido já existe. Escolha outro." });
        return;
      }
      throw err;
    }
    if (joinedServer !== null) {
      const member = listMembers(db, hub, joinedServer).find((m) => m.id === id);
      hub.publishToServer(joinedServer, { type: "member.joined", serverId: joinedServer, member });
    }
    clear(res, PENDING_COOKIE);
    startSession(res, id);
    res.status(201).json({ user: { id, username, isAdmin: firstAccount, mustChangePassword: false, ...profileOf(id) } });
  });

  // ---------------------------------------------------------------- contas vinculadas (Minha conta)
  const auth = requireAuth(cfg);

  router.get("/identities", auth, (_req, res) => {
    const userId = res.locals.userId as number;
    const rows = db.prepare("SELECT provider, created_at FROM identities WHERE user_id = ? ORDER BY provider").all(userId) as { provider: ProviderName; created_at: string }[];
    const hash = (db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string }).password_hash;
    res.json({ identities: rows.map((r) => ({ provider: r.provider, createdAt: r.created_at })), hasPassword: hash !== NO_PASSWORD });
  });

  router.post("/unlink", auth, (req, res) => {
    const userId = res.locals.userId as number;
    const provider = req.body?.provider;
    if (!(PROVIDER_NAMES as unknown[]).includes(provider)) {
      res.status(400).json({ error: "Provedor inválido" });
      return;
    }
    const mine = db.prepare("SELECT provider FROM identities WHERE user_id = ?").all(userId) as { provider: string }[];
    if (!mine.some((m) => m.provider === provider)) {
      res.status(404).json({ error: "Essa conta não está vinculada" });
      return;
    }
    const hash = (db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string }).password_hash;
    if (hash === NO_PASSWORD && mine.length <= 1) {
      res.status(400).json({ error: "Esse é o seu único jeito de entrar. Vincule outra conta antes de desvincular." });
      return;
    }
    db.prepare("DELETE FROM identities WHERE user_id = ? AND provider = ?").run(userId, provider);
    res.status(204).end();
  });

  return router;
}
