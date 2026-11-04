import { describe, expect, it, vi } from "vitest";
import { OAuthError, buildProviders, challengeOf, githubProvider, googleProvider, sanitizeNick } from "./oauth.js";

const cred = { clientId: "id-do-cliente", clientSecret: "segredo-do-cliente" };
const redirectUri = "https://concord.exemplo.com/api/auth/oauth/google/callback";

const jwtLike = (claims: object) => `cabecalho.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.assinatura`;
const resposta = (body: object, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const agora = Date.UTC(2026, 10, 10, 12);
const valido = { aud: cred.clientId, iss: "https://accounts.google.com", exp: agora / 1000 + 600, sub: "1234567890", email: "maria.silva@gmail.com", email_verified: true, name: "Maria da Silva" };

describe("apelido sugerido", () => {
  it("limpa acentos, espaços e símbolos; limita a 20; cai em 'amigo' se não sobrar nada", () => {
    expect(sanitizeNick("João Pedro")).toBe("Joao_Pedro");
    expect(sanitizeNick("  ***maria.silva***  ")).toBe("maria_silva");
    expect(sanitizeNick("a".repeat(40))).toHaveLength(20);
    for (const ruim of ["", "ab", "!!!", "日本語", undefined, null]) expect(sanitizeNick(ruim as any)).toBe("amigo");
  });
});

describe("Google", () => {
  it("o endereço de autorização leva state, PKCE (S256), escopos mínimos e pede para escolher a conta", () => {
    const url = new URL(googleProvider(cred).authorizeUrl({ state: "ST", challenge: challengeOf("verificador"), redirectUri }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: cred.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: "ST",
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    expect(url.searchParams.get("code_challenge")).toBe(challengeOf("verificador"));
    expect(url.toString()).not.toContain(cred.clientSecret);
  });

  it("troca o código (com o verificador e o segredo) e devolve o id e um apelido sugerido, sem guardar o e-mail", async () => {
    const f = vi.fn(async () => resposta({ id_token: jwtLike(valido) }));
    const perfil = await googleProvider(cred, f as any, () => agora).exchange({ code: "COD", verifier: "VER", redirectUri });
    expect(perfil).toEqual({ subject: "1234567890", suggestedNick: "Maria" });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const corpo = new URLSearchParams(init.body);
    expect(Object.fromEntries(corpo)).toMatchObject({ code: "COD", code_verifier: "VER", client_secret: cred.clientSecret, grant_type: "authorization_code", redirect_uri: redirectUri });
  });

  it("recusa token emitido para outro aplicativo, por outro emissor, vencido, sem e-mail verificado ou sem id", async () => {
    const tenta = (claims: object) => googleProvider(cred, (async () => resposta({ id_token: jwtLike(claims) })) as any, () => agora).exchange({ code: "c", verifier: "v", redirectUri });
    for (const ruim of [
      { ...valido, aud: "outro-app" },
      { ...valido, iss: "https://evil.example.com" },
      { ...valido, exp: agora / 1000 - 10 },
      { ...valido, email_verified: false },
      { ...valido, sub: "" },
      { ...valido, sub: undefined },
    ]) {
      await expect(tenta(ruim)).rejects.toBeInstanceOf(OAuthError);
    }
    await expect(tenta(valido)).resolves.toMatchObject({ subject: "1234567890" });
  });

  it("falha do Google, resposta sem id_token ou lixo viram um erro com texto seguro (sem detalhes técnicos)", async () => {
    const com = (f: unknown) => googleProvider(cred, f as any, () => agora).exchange({ code: "c", verifier: "v", redirectUri });
    await expect(com(async () => resposta({ error: "invalid_grant", error_description: "segredo vazado aqui" }, 400))).rejects.toThrow("O provedor recusou o login. Tente de novo.");
    await expect(com(async () => resposta({}))).rejects.toThrow("Resposta do Google inválida");
    await expect(com(async () => resposta({ id_token: "lixo" }))).rejects.toThrow("Resposta do Google inválida");
    await expect(com(async () => { throw new Error("rede caiu"); })).rejects.toThrow("rede caiu"); // o chamador transforma em mensagem genérica
  });
});

describe("GitHub", () => {
  it("o endereço de autorização leva state e só pede o perfil público", () => {
    const url = new URL(githubProvider(cred).authorizeUrl({ state: "ST", challenge: "x", redirectUri }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: cred.clientId, state: "ST", scope: "read:user" });
  });

  it("troca o código, lê o perfil e usa o id numérico como identidade e o login como apelido sugerido", async () => {
    const f = vi.fn(async (url: string) => (url.includes("access_token") ? resposta({ access_token: "tok" }) : resposta({ id: 4242, login: "maria-dev" })));
    const perfil = await githubProvider(cred, f as any).exchange({ code: "COD", verifier: "", redirectUri });
    expect(perfil).toEqual({ subject: "4242", suggestedNick: "maria_dev" });
    const segunda = f.mock.calls[1] as any;
    expect(segunda[1].headers.Authorization).toBe("Bearer tok");
  });

  it("recusa quando não há token ou o perfil não tem id", async () => {
    const com = (f: unknown) => githubProvider(cred, f as any).exchange({ code: "c", verifier: "", redirectUri });
    await expect(com(async () => resposta({ error: "bad_verification_code" }, 200))).rejects.toBeInstanceOf(OAuthError);
    await expect(com(async (url: string) => (url.includes("access_token") ? resposta({ access_token: "t" }) : resposta({ login: "x" })))).rejects.toBeInstanceOf(OAuthError);
    await expect(com(async (url: string) => (url.includes("access_token") ? resposta({ access_token: "t" }) : resposta({ message: "Bad credentials" }, 401)))).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("configuração", () => {
  it("só liga o que tem credenciais completas e um PUBLIC_URL (sem barra no fim)", () => {
    expect(buildProviders({}).providers).toEqual({});
    expect(buildProviders({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" }).providers).toEqual({}); // sem PUBLIC_URL
    const { providers, publicUrl } = buildProviders({ PUBLIC_URL: "https://concord.exemplo.com/", GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", GITHUB_CLIENT_ID: "c" });
    expect(Object.keys(providers)).toEqual(["google"]); // GitHub incompleto (falta o segredo)
    expect(publicUrl).toBe("https://concord.exemplo.com");
  });
});
