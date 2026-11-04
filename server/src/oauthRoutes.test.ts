import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthError, type ExternalProfile, type Provider, type ProviderName } from "./oauth.js";
import { closeAll, start } from "./testkit.js";

afterEach(closeAll);

const PUBLIC = "https://concord.exemplo.com";
const SETUP = "codigo-secreto-do-dono-123";

/** Provedor de mentira: cada "código" aponta para um perfil; código desconhecido vira erro. */
function fake(name: ProviderName, codes: Map<string, ExternalProfile>): Provider {
  return {
    name,
    authorizeUrl: ({ state, challenge, redirectUri }) => `https://fake.${name}/auth?${new URLSearchParams({ state, challenge, redirect_uri: redirectUri })}`,
    async exchange({ code }) {
      const p = codes.get(code);
      if (!p) throw new OAuthError("recusado");
      return p;
    },
  };
}

async function setup() {
  const codes = new Map<string, ExternalProfile>();
  const providers = { google: fake("google", codes), github: fake("github", codes) };
  const s = await start({ inviteOnly: true, setupCode: SETUP, oauth: { providers, publicUrl: PUBLIC } });
  /** A dona se cadastra com o código secreto de instalação (o servidor é fechado). */
  const agente = request.agent(s.app);
  const reg = await agente.post("/api/auth/register").send({ username: "ana", password: "senha-bem-longa", inviteCode: SETUP });
  const ana = { agent: agente, cookie: String(reg.headers["set-cookie"][0]).split(";")[0], id: reg.body.user.id as number };
  const server = (await ana.agent.post("/api/servers").send({ name: "Os Parças" })).body.server;
  const convite = async () => (await ana.agent.post(`/api/servers/${server.id}/invites`)).body.code as string;
  /** Outra conta de usuário e senha, criada com um convite da Ana. */
  const novaConta = async (username: string) => {
    const agent = request.agent(s.app);
    const r = await agent.post("/api/auth/register").send({ username, password: "senha-bem-longa", inviteCode: await convite() });
    return { agent, id: r.body.user.id as number };
  };

  /** Percorre ida e volta do provedor com um navegador novo (ou o informado). */
  async function entrar(provider: ProviderName, perfil: ExternalProfile, q: { invite?: string; mode?: string } = {}, agent = request.agent(s.app)) {
    const ida = await agent.get(`/api/auth/oauth/${provider}/start`).query(q);
    const state = new URL(ida.headers.location).searchParams.get("state")!;
    codes.set("codigo", perfil);
    const volta = await agent.get(`/api/auth/oauth/${provider}/callback`).query({ code: "codigo", state });
    return { agent, ida, volta, state };
  }
  return { ...s, ana, server, convite, novaConta, entrar, codes, providers };
}

const maria: ExternalProfile = { subject: "g-111", suggestedNick: "Maria" };

describe("começo do caminho", () => {
  it("lista só os provedores ligados", async () => {
    const { app } = await setup();
    expect((await request(app).get("/api/auth/oauth/providers")).body).toEqual({ google: true, github: true });
    const s = await start({ oauth: { providers: {}, publicUrl: PUBLIC } });
    expect((await request(s.app).get("/api/auth/oauth/providers")).body).toEqual({ google: false, github: false });
    const sem = await start();
    expect((await request(sem.app).get("/api/auth/oauth/providers")).body).toEqual({ google: false, github: false });
  });

  it("start manda para o provedor com state, desafio PKCE e o endereço de retorno fixo; o cookie é httpOnly e SameSite=Lax", async () => {
    const { app } = await setup();
    const r = await request(app).get("/api/auth/oauth/google/start").query({ invite: "abc" });
    expect(r.status).toBe(302);
    const alvo = new URL(r.headers.location);
    expect(alvo.origin).toBe("https://fake.google");
    expect(alvo.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/api/auth/oauth/google/callback`);
    expect(alvo.searchParams.get("state")!.length).toBeGreaterThanOrEqual(40);
    expect(alvo.searchParams.get("challenge")!.length).toBeGreaterThanOrEqual(40);
    const cookie = String(r.headers["set-cookie"]);
    expect(cookie).toMatch(/concord_oauth=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/oauth/);
  });

  it("o endereço de retorno nunca vem do cabeçalho Host (um site de fora não pode trocá-lo)", async () => {
    const { app } = await setup();
    const r = await request(app).get("/api/auth/oauth/google/start").set("Host", "evil.example.com").set("X-Forwarded-Host", "evil.example.com");
    expect(new URL(r.headers.location).searchParams.get("redirect_uri")).toBe(`${PUBLIC}/api/auth/oauth/google/callback`);
  });

  it("provedor desligado ou desconhecido: volta para a tela de entrada com o motivo", async () => {
    const s = await start({ oauth: { providers: {}, publicUrl: PUBLIC } });
    expect((await request(s.app).get("/api/auth/oauth/google/start")).headers.location).toBe("/?oauth_erro=indisponivel");
    expect((await request(s.app).get("/api/auth/oauth/facebook/start")).headers.location).toBe("/?oauth_erro=indisponivel");
  });

  it("ninguém consegue o convite do outro por esta rota: o código do convite só passa por caracteres seguros", async () => {
    const { app } = await setup();
    const r = await request(app).get("/api/auth/oauth/google/start").query({ invite: "<script>alert(1)</script>" });
    expect(r.status).toBe(302); // continua, mas ignora o convite malformado
  });
});

describe("entrar pela primeira vez: convite + apelido", () => {
  it("convite válido: callback leva à escolha do apelido; completar cria a conta, entra no servidor, gasta o convite e abre a sessão", async () => {
    const { app, convite, server, entrar } = await setup();
    const code = await convite();
    const { agent, volta } = await entrar("google", maria, { invite: code });
    expect(volta.headers.location).toBe("/?oauth=apelido");
    expect(String(volta.headers["set-cookie"])).toMatch(/concord_pending=/);

    expect((await agent.get("/api/auth/oauth/pending")).body).toEqual({ provider: "google", suggestedNick: "Maria" });
    const feito = await agent.post("/api/auth/oauth/complete").send({ username: "Maria_S" });
    expect(feito.status).toBe(201);
    expect(feito.body.user).toMatchObject({ username: "Maria_S", isAdmin: false });

    expect((await agent.get("/api/auth/me")).body.user.username).toBe("Maria_S"); // sessão aberta
    expect((await agent.get("/api/servers")).body.servers.map((x: any) => x.id)).toEqual([server.id]); // já está no servidor
    expect((await request(app).post(`/api/invites/${code}/join`).send()).status).toBe(401); // o convite foi gasto (e sem login nem tenta)
    expect((await agent.get("/api/auth/oauth/pending")).status).toBe(404); // o cadastro pendente some
    expect((await agent.post("/api/auth/oauth/complete").send({ username: "Outro_Nome" })).status).toBe(410); // não dá para completar duas vezes
  });

  it("a conta criada assim não tem senha: nenhuma senha (nem '!' nem vazia) abre o login por usuário e senha", async () => {
    const { app, convite, entrar } = await setup();
    const { agent } = await entrar("google", maria, { invite: await convite() });
    await agent.post("/api/auth/oauth/complete").send({ username: "Maria_S" });
    for (const password of ["!", "", "senha-qualquer-123", "Maria_S"]) {
      const r = await request(app).post("/api/auth/login").send({ username: "Maria_S", password });
      expect([400, 401], password).toContain(r.status);
    }
  });

  it("sem convite, com convite inventado ou já usado: barrado com 'sem-convite', sem cadastro pendente", async () => {
    const { convite, entrar, ana } = await setup();
    const usado = await convite();
    await entrar("google", maria, { invite: usado }).then(({ agent }) => agent.post("/api/auth/oauth/complete").send({ username: "Maria_S" }));
    void ana;
    for (const q of [{}, { invite: "inventado123" }, { invite: usado }]) {
      const { agent, volta } = await entrar("github", { subject: "gh-9", suggestedNick: "intruso" }, q);
      expect(volta.headers.location, JSON.stringify(q)).toBe("/?oauth_erro=sem-convite");
      expect((await agent.get("/api/auth/oauth/pending")).status).toBe(404);
    }
  });

  it("depois de entrar a primeira vez, voltar é só clicar de novo (sem convite); o outro provedor é outra identidade", async () => {
    const { convite, entrar } = await setup();
    const { agent } = await entrar("google", maria, { invite: await convite() });
    await agent.post("/api/auth/oauth/complete").send({ username: "Maria_S" });

    const volta = await entrar("google", maria);
    expect(volta.volta.headers.location).toBe("/");
    expect((await volta.agent.get("/api/auth/me")).body.user.username).toBe("Maria_S");

    const outro = await entrar("github", { subject: "gh-111", suggestedNick: "maria" }); // mesmo "id" 111, outro provedor: não é a mesma pessoa
    expect(outro.volta.headers.location).toBe("/?oauth_erro=sem-convite");
  });

  it("quem já tem conta e chega por um link de convite novo entra também no servidor do convite", async () => {
    const { ana, server, convite, entrar } = await setup();
    const outroServidor = (await ana.agent.post("/api/servers").send({ name: "Segundo" })).body.server;
    const codeA = await convite();
    const { agent } = await entrar("google", maria, { invite: codeA });
    await agent.post("/api/auth/oauth/complete").send({ username: "Maria_S" });
    const segundo = (await ana.agent.post(`/api/servers/${outroServidor.id}/invites`)).body.code;

    const { agent: de_novo } = await entrar("google", maria, { invite: segundo });
    expect((await de_novo.get("/api/servers")).body.servers.map((x: any) => x.id).sort()).toEqual([server.id, outroServidor.id].sort());
  });

  it("a dona entra pela primeira vez com o código secreto de instalação e vira administradora", async () => {
    const codes = new Map<string, ExternalProfile>();
    const s = await start({ inviteOnly: true, setupCode: SETUP, oauth: { providers: { google: fake("google", codes) }, publicUrl: PUBLIC } });
    const agent = request.agent(s.app);
    const state = new URL((await agent.get("/api/auth/oauth/google/start").query({ invite: SETUP })).headers.location).searchParams.get("state")!;
    codes.set("c", { subject: "g-dona", suggestedNick: "Dona" });
    expect((await agent.get("/api/auth/oauth/google/callback").query({ code: "c", state })).headers.location).toBe("/?oauth=apelido");
    const r = await agent.post("/api/auth/oauth/complete").send({ username: "Dona" });
    expect(r.body.user.isAdmin).toBe(true);
    // depois que existe conta, o código secreto não vale mais
    const outro = request.agent(s.app);
    const st2 = new URL((await outro.get("/api/auth/oauth/google/start").query({ invite: SETUP })).headers.location).searchParams.get("state")!;
    codes.set("c2", { subject: "g-intruso", suggestedNick: "x" });
    expect((await outro.get("/api/auth/oauth/google/callback").query({ code: "c2", state: st2 })).headers.location).toBe("/?oauth_erro=sem-convite");
  });

  it("servidor aberto (desenvolvimento): entra sem convite", async () => {
    const codes = new Map<string, ExternalProfile>();
    const s = await start({ oauth: { providers: { google: fake("google", codes) }, publicUrl: PUBLIC } });
    const agent = request.agent(s.app);
    const state = new URL((await agent.get("/api/auth/oauth/google/start")).headers.location).searchParams.get("state")!;
    codes.set("c", maria);
    expect((await agent.get("/api/auth/oauth/google/callback").query({ code: "c", state })).headers.location).toBe("/?oauth=apelido");
    expect((await agent.post("/api/auth/oauth/complete").send({ username: "Maria_S" })).status).toBe(201);
  });
});

describe("apelido", () => {
  it("só 3 a 20 letras, números ou _; apelido já usado (sem diferenciar maiúsculas) é recusado e o convite não é gasto", async () => {
    const { ana, convite, entrar } = await setup();
    const code = await convite();
    const { agent } = await entrar("google", maria, { invite: code });
    for (const ruim of ["ab", "a".repeat(21), "com espaço", "acentuação", "<b>", "", 5, null]) {
      expect((await agent.post("/api/auth/oauth/complete").send({ username: ruim })).status, String(ruim)).toBe(400);
    }
    expect((await agent.post("/api/auth/oauth/complete").send({ username: "ANA" })).status).toBe(409); // "ana" já existe
    expect((await agent.post("/api/auth/oauth/complete").send({ username: "Maria_S" })).status).toBe(201); // o mesmo convite ainda valia
    void ana;
  });

  it("cadastro pendente adulterado, de outro tipo ou sem cookie: 410", async () => {
    const { app, entrar, convite } = await setup();
    expect((await request(app).post("/api/auth/oauth/complete").send({ username: "Maria_S" })).status).toBe(410);
    const falso = jwt.sign({ pur: "pending", p: "google", sub: "g-1", inv: await convite() }, "outro-segredo", { algorithm: "HS256" });
    expect((await request(app).post("/api/auth/oauth/complete").set("Cookie", `concord_pending=${falso}`).send({ username: "Maria_S" })).status).toBe(410);
    // um cookie de sessão de verdade não serve como cadastro pendente
    const { agent } = await entrar("google", maria, { invite: await convite() });
    await agent.post("/api/auth/oauth/complete").send({ username: "Maria_S" });
    const sessao = String(((await agent.get("/api/auth/me")).request as any)._header).match(/concord_session=([^;\s]+)/)?.[1] ?? "";
    expect((await request(app).post("/api/auth/oauth/complete").set("Cookie", `concord_pending=${sessao}`).send({ username: "Outra_Pessoa" })).status).toBe(410);
  });

  it("dois cadastros disputando o mesmo convite: só um conclui; o outro leva 410 e não deixa conta pela metade", async () => {
    const { app, convite, entrar } = await setup();
    const code = await convite();
    const a = await entrar("google", { subject: "g-A", suggestedNick: "A" }, { invite: code });
    const b = await entrar("github", { subject: "gh-B", suggestedNick: "B" }, { invite: code });
    expect((await a.agent.post("/api/auth/oauth/complete").send({ username: "Pessoa_A" })).status).toBe(201);
    const segundo = await b.agent.post("/api/auth/oauth/complete").send({ username: "Pessoa_B" });
    expect(segundo.status).toBe(403); // o convite já não vale: cai na regra "só por convite"
    expect((await request(app).post("/api/auth/login").send({ username: "Pessoa_B", password: "x".repeat(10) })).status).toBe(401); // a conta B não existe
  });
});

describe("volta do provedor: tudo que pode dar errado", () => {
  it("sem cookie, state trocado, state repetido ou provedor trocado: 'expirou'; o fluxo vale uma vez só", async () => {
    const { app, convite, entrar, codes } = await setup();
    const code = await convite();
    codes.set("codigo", maria);
    expect((await request(app).get("/api/auth/oauth/google/callback").query({ code: "codigo", state: "qualquer" })).headers.location).toBe("/?oauth_erro=expirou");

    const agent = request.agent(app);
    const state = new URL((await agent.get("/api/auth/oauth/google/start").query({ invite: code })).headers.location).searchParams.get("state")!;
    expect((await agent.get("/api/auth/oauth/google/callback").query({ code: "codigo", state: "errado" })).headers.location).toBe("/?oauth_erro=expirou");
    // o cookie foi gasto na tentativa errada: nem o state certo funciona depois
    expect((await agent.get("/api/auth/oauth/google/callback").query({ code: "codigo", state })).headers.location).toBe("/?oauth_erro=expirou");

    const a2 = request.agent(app);
    const st2 = new URL((await a2.get("/api/auth/oauth/google/start").query({ invite: code })).headers.location).searchParams.get("state")!;
    expect((await a2.get("/api/auth/oauth/github/callback").query({ code: "codigo", state: st2 })).headers.location).toBe("/?oauth_erro=expirou"); // outro provedor

    void entrar;
  });

  it("a pessoa cancelou no provedor, ou a troca do código falhou: mensagens próprias e nada de cadastro", async () => {
    const { app, convite } = await setup();
    const code = await convite();
    const a = request.agent(app);
    const s1 = new URL((await a.get("/api/auth/oauth/google/start").query({ invite: code })).headers.location).searchParams.get("state")!;
    expect((await a.get("/api/auth/oauth/google/callback").query({ error: "access_denied", state: s1 })).headers.location).toBe("/?oauth_erro=cancelado");
    const b = request.agent(app);
    const s2 = new URL((await b.get("/api/auth/oauth/google/start").query({ invite: code })).headers.location).searchParams.get("state")!;
    expect((await b.get("/api/auth/oauth/google/callback").query({ code: "codigo-que-ninguem-conhece", state: s2 })).headers.location).toBe("/?oauth_erro=falhou");
    expect((await b.get("/api/auth/oauth/pending")).status).toBe(404);
  });

  it("limite de tentativas por endereço", async () => {
    const codes = new Map();
    const s = await start({ rateLimit: true, oauth: { providers: { google: fake("google", codes) }, publicUrl: PUBLIC } });
    for (let i = 0; i < 60; i++) expect((await request(s.app).get("/api/auth/oauth/google/start")).status).toBe(302);
    expect((await request(s.app).get("/api/auth/oauth/google/start")).status).toBe(429);
  });
});

describe("contas vinculadas (Minha conta)", () => {
  it("vincular exige estar logada; vincula, lista e permite entrar pelo Google; a mesma conta externa não vai para duas contas", async () => {
    const { app, ana, entrar, novaConta } = await setup();
    const sem = await request(app).get("/api/auth/oauth/google/start").query({ mode: "link" });
    expect(sem.headers.location).toBe("/?oauth_erro=sem-login");

    const r = await entrar("google", { subject: "g-ana", suggestedNick: "Ana" }, { mode: "link" }, ana.agent);
    expect(r.volta.headers.location).toBe("/?oauth_ok=vinculado");
    expect((await ana.agent.get("/api/auth/oauth/identities")).body).toMatchObject({ identities: [{ provider: "google" }], hasPassword: true });

    const entrando = await entrar("google", { subject: "g-ana", suggestedNick: "Ana" }); // outro navegador
    expect(entrando.volta.headers.location).toBe("/");
    expect((await entrando.agent.get("/api/auth/me")).body.user.username).toBe("ana");

    // outra conta tentando vincular o mesmo Google da Ana
    const beto = await novaConta("beto");
    const dele = await entrar("google", { subject: "g-ana", suggestedNick: "Ana" }, { mode: "link" }, beto.agent);
    expect(dele.volta.headers.location).toBe("/?oauth_erro=ja-vinculada");
    // a mesma conta já tem um Google ligado
    const dois = await entrar("google", { subject: "g-outro", suggestedNick: "x" }, { mode: "link" }, ana.agent);
    expect(dois.volta.headers.location).toBe("/?oauth_erro=ja-tem");
  });

  it("outra pessoa não consegue vincular na sua conta com o cookie do fluxo de outro navegador", async () => {
    const { ana, novaConta } = await setup();
    const beto = await novaConta("beto");
    // Ana inicia o vínculo; o navegador do Beto tenta concluir com o state da Ana (sem o cookie dela)
    const ida = await ana.agent.get("/api/auth/oauth/google/start").query({ mode: "link" });
    const state = new URL(ida.headers.location).searchParams.get("state")!;
    const r = await beto.agent.get("/api/auth/oauth/google/callback").query({ code: "codigo", state });
    expect(r.headers.location).toBe("/?oauth_erro=expirou");
  });

  it("desvincular: com senha pode; conta só do Google não pode desvincular o único jeito de entrar", async () => {
    const { app, ana, convite, entrar } = await setup();
    await entrar("github", { subject: "gh-ana", suggestedNick: "ana" }, { mode: "link" }, ana.agent);
    expect((await ana.agent.post("/api/auth/oauth/unlink").send({ provider: "github" })).status).toBe(204); // tem senha
    expect((await ana.agent.post("/api/auth/oauth/unlink").send({ provider: "github" })).status).toBe(404); // já não está
    expect((await ana.agent.post("/api/auth/oauth/unlink").send({ provider: "facebook" })).status).toBe(400);

    const { agent } = await entrar("google", maria, { invite: await convite() });
    await agent.post("/api/auth/oauth/complete").send({ username: "Maria_S" });
    expect((await agent.get("/api/auth/oauth/identities")).body.hasPassword).toBe(false);
    const preso = await agent.post("/api/auth/oauth/unlink").send({ provider: "google" });
    expect(preso.status).toBe(400);
    expect(preso.body.error).toMatch(/único jeito de entrar/);
    // com outro provedor vinculado, aí pode
    await entrar("github", { subject: "gh-maria", suggestedNick: "maria" }, { mode: "link" }, agent);
    expect((await agent.post("/api/auth/oauth/unlink").send({ provider: "google" })).status).toBe(204);
    void app;
  });

  it("sem login, as rotas de contas vinculadas respondem 401", async () => {
    const { app } = await setup();
    expect((await request(app).get("/api/auth/oauth/identities")).status).toBe(401);
    expect((await request(app).post("/api/auth/oauth/unlink").send({ provider: "google" })).status).toBe(401);
  });
});
