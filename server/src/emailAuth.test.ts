import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import type { MailMessage, Mailer } from "./mail.js";

const cfg = { jwtSecret: "teste", secureCookies: false };

/** App com um "correio" falso que guarda tudo o que seria enviado. */
function appWithMail(enabled = true) {
  const sent: MailMessage[] = [];
  const mailer: Mailer = { send: async (m) => void sent.push(m) };
  const app = createApp({ db: openDb(), ...cfg, rateLimit: false, mailer: enabled ? mailer : null, oauth: { providers: {}, publicUrl: "https://concord.teste" } });
  const lastCode = () => /\b(\d{6})\b/.exec(sent[sent.length - 1].text)![1];
  return { app, sent, lastCode };
}

const PASS = "senha-bem-longa";

async function registered(app: ReturnType<typeof createApp>, username = "ana", email = "ana@exemplo.com") {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({ username, password: PASS, email });
  return { agent, res };
}

describe("e-mail desligado (sem SMTP)", () => {
  it("o app funciona como antes: cadastro sem e-mail, sem 'esqueci a senha'", async () => {
    const { app } = appWithMail(false);
    expect((await request(app).get("/api/auth/mail")).body).toEqual({ enabled: false });
    const res = await request(app).post("/api/auth/register").send({ username: "ana", password: PASS });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: null, emailVerified: false, emailPending: false });
    expect((await request(app).post("/api/auth/forgot").send({ email: "ana@exemplo.com" })).status).toBe(503);
    expect((await request(app).post("/api/auth/login").send({ username: "ana", password: PASS })).status).toBe(200);
  });
});

describe("confirmar o e-mail no cadastro", () => {
  it("exige um e-mail válido; manda o código; só vale depois de confirmar; chega o e-mail de boas-vindas", async () => {
    const { app, sent, lastCode } = appWithMail();
    expect((await request(app).get("/api/auth/mail")).body).toEqual({ enabled: true });
    expect((await request(app).post("/api/auth/register").send({ username: "ana", password: PASS })).status).toBe(400);
    expect((await request(app).post("/api/auth/register").send({ username: "ana", password: PASS, email: "isso-nao-e-email" })).status).toBe(400);

    const { agent, res } = await registered(app);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: null, emailVerified: false, emailPending: true, pendingEmail: "ana@exemplo.com" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ana@exemplo.com");
    expect(sent[0].subject).toContain("código");

    // código errado não confirma
    const wrong = await agent.post("/api/auth/email/verify").send({ code: lastCode() === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(400);
    expect((await agent.get("/api/auth/me")).body.user.emailPending).toBe(true);

    const code = lastCode();
    const ok = await agent.post("/api/auth/email/verify").send({ code });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ email: "ana@exemplo.com", emailVerified: true, emailPending: false, pendingEmail: null });
    await vi_waitFor(() => sent.length === 2);
    expect(sent[1].subject).toContain("Bem-vindo");
    expect(sent[1].html).toContain("https://concord.teste");
    expect((await agent.get("/api/auth/me")).body.user).toMatchObject({ email: "ana@exemplo.com", emailPending: false });

    // o código não serve duas vezes
    expect((await agent.post("/api/auth/email/verify").send({ code })).status).toBe(400);
  });

  it("limita as tentativas do código; um código novo invalida o antigo e tem intervalo mínimo", async () => {
    const { app, sent, lastCode } = appWithMail();
    const { agent } = await registered(app);
    const real = lastCode();
    const bad = real === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) expect((await agent.post("/api/auth/email/verify").send({ code: bad })).status).toBe(400);
    // estourou as tentativas: nem o código certo vale mais
    expect((await agent.post("/api/auth/email/verify").send({ code: real })).status).toBe(429);

    // pedir outro de novo em seguida: precisa esperar
    expect((await agent.post("/api/auth/email/send-code").send({ email: "ana@exemplo.com" })).status).toBe(429);
    expect(sent).toHaveLength(1);
  });

  it("o mesmo e-mail não serve para duas contas", async () => {
    const { app, lastCode } = appWithMail();
    const ana = await registered(app);
    await ana.agent.post("/api/auth/email/verify").send({ code: lastCode() });
    const outra = await registered(app, "beto", "ANA@exemplo.com");
    expect(outra.res.status).toBe(409);
    // e quem já tem conta também não pode trocar para um e-mail confirmado por outra pessoa
    const beto = await registered(app, "beto", "beto@exemplo.com");
    expect(beto.res.status).toBe(201);
    expect((await beto.agent.post("/api/auth/email/send-code").send({ email: "ana@exemplo.com" })).status).toBe(409);
  });

  it("conta antiga (criada sem e-mail) não é obrigada a ter um, mas pode adicionar depois", async () => {
    const db = openDb();
    const velho = createApp({ db, ...cfg, rateLimit: false });
    await request(velho).post("/api/auth/register").send({ username: "velha", password: PASS });

    // o servidor passa a ter envio de e-mail
    const sent: MailMessage[] = [];
    const app = createApp({ db, ...cfg, rateLimit: false, mailer: { send: async (m) => void sent.push(m) } });
    const agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({ username: "velha", password: PASS });
    expect(login.body.user).toMatchObject({ emailVerified: false, emailPending: false });

    expect((await agent.post("/api/auth/email/send-code").send({ email: "velha@exemplo.com" })).status).toBe(204);
    const code = /([0-9]{6})/.exec(sent[0].text)![1];
    expect((await agent.post("/api/auth/email/verify").send({ code })).body).toMatchObject({ emailVerified: true });
  });
});

describe("esqueci a senha", () => {
  async function accountWithEmail() {
    const ctx = appWithMail();
    const ana = await registered(ctx.app);
    await ana.agent.post("/api/auth/email/verify").send({ code: ctx.lastCode() });
    await vi_waitFor(() => ctx.sent.length === 2); // código + boas-vindas
    return { ...ctx, ana };
  }

  it("e-mail que não existe responde igual e não manda nada", async () => {
    const { app, sent } = await accountWithEmail();
    const before = sent.length;
    const res = await request(app).post("/api/auth/forgot").send({ email: "ninguem@exemplo.com" });
    expect(res.status).toBe(204);
    expect(sent).toHaveLength(before);
    expect((await request(app).post("/api/auth/forgot").send({ email: "xxx" })).status).toBe(400);
  });

  it("recebe o código com o nome de usuário, troca a senha, entra logo e os logins antigos caem", async () => {
    const { app, sent, lastCode, ana } = await accountWithEmail();
    expect((await request(app).post("/api/auth/forgot").send({ email: "ANA@exemplo.com" })).status).toBe(204);
    const mail = sent[sent.length - 1];
    expect(mail.to).toBe("ana@exemplo.com");
    expect(mail.text).toContain('"ana"');
    const code = lastCode();

    // código errado e senha curta não passam
    expect((await request(app).post("/api/auth/reset").send({ email: "ana@exemplo.com", code: "000000", password: "nova-senha-123" })).status).toBe(400);
    expect((await request(app).post("/api/auth/reset").send({ email: "ana@exemplo.com", code, password: "curta" })).status).toBe(400);

    const novo = request.agent(app);
    const reset = await novo.post("/api/auth/reset").send({ email: "ana@exemplo.com", code, password: "nova-senha-123" });
    expect(reset.status).toBe(204);
    expect((await novo.get("/api/auth/me")).status).toBe(200); // já entrou com a senha nova
    expect((await ana.agent.get("/api/auth/me")).status).toBe(401); // o login antigo caiu
    expect((await request(app).post("/api/auth/login").send({ username: "ana", password: PASS })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ username: "ana", password: "nova-senha-123" })).status).toBe(200);
    await vi_waitFor(() => sent[sent.length - 1].subject.includes("alterada"));

    // o mesmo código não serve de novo
    expect((await request(app).post("/api/auth/reset").send({ email: "ana@exemplo.com", code, password: "outra-senha-123" })).status).toBe(400);
  });

  it("e-mail ainda não confirmado não recupera nada", async () => {
    const { app, sent } = appWithMail();
    await registered(app); // cadastrou, mas não confirmou
    const before = sent.length;
    expect((await request(app).post("/api/auth/forgot").send({ email: "ana@exemplo.com" })).status).toBe(204);
    expect(sent).toHaveLength(before);
  });
});

/** Os e-mails de aviso saem em segundo plano: espera até aparecerem. */
async function vi_waitFor(cond: () => boolean) {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
}
