import { createHash, randomBytes } from "node:crypto";

export type ProviderName = "google" | "github";
export const PROVIDER_NAMES: ProviderName[] = ["google", "github"];

/** Quem a pessoa é no provedor. Só o id importa para a identidade; o resto serve para sugerir um apelido. */
export interface ExternalProfile {
  subject: string;
  suggestedNick: string;
}

export interface Provider {
  name: ProviderName;
  authorizeUrl(p: { state: string; challenge: string; redirectUri: string }): string;
  exchange(p: { code: string; verifier: string; redirectUri: string }): Promise<ExternalProfile>;
}

/** Erro com texto seguro para mostrar à pessoa (o detalhe técnico não vaza). */
export class OAuthError extends Error {}

type Fetch = typeof fetch;
const TIMEOUT_MS = 8000;

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Apelido válido (3 a 20 letras, números ou _) a partir de qualquer texto; "amigo" se não sobrar nada aproveitável. */
export function sanitizeNick(raw: string | undefined | null): string {
  const base = (raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // tira acentos
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  return base.length >= 3 ? base : "amigo";
}

async function postForm(fetchFn: Fetch, url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.error) throw new OAuthError("O provedor recusou o login. Tente de novo.");
  return data;
}

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

/**
 * Google (OpenID Connect, código + PKCE). O id_token chega direto do endereço do Google por HTTPS, então não precisa
 * de verificação de assinatura; conferimos para quem ele foi emitido, por quem, a validade e se o e-mail é verificado.
 */
export function googleProvider(cred: Credentials, fetchFn: Fetch = fetch, now: () => number = () => Date.now()): Provider {
  return {
    name: "google",
    authorizeUrl: ({ state, challenge, redirectUri }) =>
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        client_id: cred.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString(),
    async exchange({ code, verifier, redirectUri }) {
      const data = await postForm(fetchFn, "https://oauth2.googleapis.com/token", {
        code,
        client_id: cred.clientId,
        client_secret: cred.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      });
      const idToken = typeof data.id_token === "string" ? data.id_token : "";
      let claims: Record<string, unknown>;
      try {
        claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
      } catch {
        throw new OAuthError("Resposta do Google inválida. Tente de novo.");
      }
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes(cred.clientId) || !GOOGLE_ISSUERS.includes(String(claims.iss)) || typeof claims.exp !== "number" || claims.exp * 1000 < now()) {
        throw new OAuthError("Resposta do Google inválida. Tente de novo.");
      }
      if (claims.email_verified !== true && claims.email_verified !== "true") throw new OAuthError("O e-mail dessa conta do Google não está verificado.");
      if (typeof claims.sub !== "string" || claims.sub === "") throw new OAuthError("Resposta do Google inválida. Tente de novo.");
      const email = typeof claims.email === "string" ? claims.email.split("@")[0] : "";
      return { subject: claims.sub, suggestedNick: sanitizeNick(typeof claims.name === "string" && claims.name ? claims.name.split(" ")[0] : email) };
    },
  };
}

/** GitHub (código + state). A identidade é o id numérico da conta, que não muda mesmo que a pessoa troque de login. */
export function githubProvider(cred: Credentials, fetchFn: Fetch = fetch): Provider {
  return {
    name: "github",
    authorizeUrl: ({ state, redirectUri }) =>
      "https://github.com/login/oauth/authorize?" +
      new URLSearchParams({ client_id: cred.clientId, redirect_uri: redirectUri, scope: "read:user", state, allow_signup: "true" }).toString(),
    async exchange({ code, redirectUri }) {
      const data = await postForm(fetchFn, "https://github.com/login/oauth/access_token", {
        client_id: cred.clientId,
        client_secret: cred.clientSecret,
        code,
        redirect_uri: redirectUri,
      });
      const token = typeof data.access_token === "string" ? data.access_token : "";
      if (!token) throw new OAuthError("O GitHub recusou o login. Tente de novo.");
      const res = await fetchFn("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "ConcordHub" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const user = (await res.json().catch(() => ({}))) as { id?: unknown; login?: unknown };
      if (!res.ok || typeof user.id !== "number") throw new OAuthError("Resposta do GitHub inválida. Tente de novo.");
      return { subject: String(user.id), suggestedNick: sanitizeNick(typeof user.login === "string" ? user.login : "") };
    },
  };
}

export type Providers = Partial<Record<ProviderName, Provider>>;

/** Liga só os provedores que têm credenciais. Sem `publicUrl` nenhum liga (não há endereço de retorno confiável). */
export function buildProviders(env: Record<string, string | undefined>): { providers: Providers; publicUrl: string | null } {
  const publicUrl = env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, "") : null;
  const providers: Providers = {};
  if (publicUrl) {
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) providers.google = googleProvider({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET });
    if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) providers.github = githubProvider({ clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET });
  }
  return { providers, publicUrl };
}
