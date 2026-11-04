import type { CookieOptions, NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export const COOKIE_NAME = "concord_session";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthConfig {
  jwtSecret: string;
  secureCookies: boolean;
  /** Versão atual do login da pessoa (null se a conta não existe). Trocar a senha ou "sair de todos" sobe a versão e derruba os logins antigos. */
  tokenVersion?: (userId: number) => number | null;
}

export function cookieOptions(cfg: AuthConfig): CookieOptions {
  return { httpOnly: true, sameSite: "lax", secure: cfg.secureCookies, maxAge: WEEK_MS };
}

export function signToken(cfg: AuthConfig, userId: number, version = 0): string {
  return jwt.sign({ sub: String(userId), ver: version }, cfg.jwtSecret, { expiresIn: "7d", algorithm: "HS256" });
}

/** Devolve o id do usuário do cookie, ou null se ausente/inválido/expirado. */
export function userIdFromToken(cfg: AuthConfig, token: unknown): number | null {
  if (typeof token !== "string") return null;
  try {
    const payload = jwt.verify(token, cfg.jwtSecret, { algorithms: ["HS256"] });
    if (typeof payload === "string" || typeof payload.sub !== "string") return null;
    const id = Number(payload.sub);
    if (!Number.isInteger(id)) return null;
    if (cfg.tokenVersion) {
      const current = cfg.tokenVersion(id);
      if (current === null || current !== (typeof payload.ver === "number" ? payload.ver : 0)) return null;
    }
    return id;
  } catch {
    return null;
  }
}

export function requireAuth(cfg: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userId = userIdFromToken(cfg, req.cookies?.[COOKIE_NAME]);
    if (userId === null) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    res.locals.userId = userId;
    next();
  };
}
