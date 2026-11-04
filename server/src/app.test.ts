import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

function newApp() {
  const db = openDb();
  return { db, app: createApp({ db, jwtSecret: "teste", secureCookies: false }) };
}

const ana = { username: "ana", password: "senha-bem-longa" };

describe("GET /api/health", () => {
  it("responde status ok", async () => {
    const res = await request(newApp().app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("auth", () => {
  it("registra, já entra logado e /me devolve o usuário", async () => {
    const agent = request.agent(newApp().app);
    const reg = await agent.post("/api/auth/register").send(ana);
    expect(reg.status).toBe(201);
    expect(reg.body.user.username).toBe("ana");
    expect(JSON.stringify(reg.body)).not.toContain("senha");

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe("ana");
  });

  it("guarda a senha só como hash", async () => {
    const { app, db } = newApp();
    await request(app).post("/api/auth/register").send(ana);
    const row = db.prepare("SELECT password_hash FROM users").get() as { password_hash: string };
    expect(row.password_hash).not.toContain(ana.password);
    expect(row.password_hash.startsWith("$2")).toBe(true);
  });

  it("usa cookie httpOnly", async () => {
    const res = await request(newApp().app).post("/api/auth/register").send(ana);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
  });

  it("recusa usuário duplicado (sem diferenciar maiúsculas) com 409", async () => {
    const { app } = newApp();
    await request(app).post("/api/auth/register").send(ana);
    const res = await request(app).post("/api/auth/register").send({ ...ana, username: "ANA" });
    expect(res.status).toBe(409);
  });

  it("valida usuário e senha no registro", async () => {
    const { app } = newApp();
    const curto = await request(app).post("/api/auth/register").send({ username: "ab", password: ana.password });
    const espaco = await request(app).post("/api/auth/register").send({ username: "a b c", password: ana.password });
    const fraca = await request(app).post("/api/auth/register").send({ username: "ana", password: "123" });
    const tipo = await request(app).post("/api/auth/register").send({ username: { $ne: 1 }, password: [1] });
    expect([curto.status, espaco.status, fraca.status, tipo.status]).toEqual([400, 400, 400, 400]);
  });

  it("login certo entra; usuário ou senha errados dão a mesma resposta 401", async () => {
    const { app } = newApp();
    await request(app).post("/api/auth/register").send(ana);

    const ok = await request(app).post("/api/auth/login").send(ana);
    expect(ok.status).toBe(200);

    const senhaErrada = await request(app).post("/api/auth/login").send({ ...ana, password: "errada-errada" });
    const semUsuario = await request(app).post("/api/auth/login").send({ username: "ninguem", password: ana.password });
    expect(senhaErrada.status).toBe(401);
    expect(semUsuario.status).toBe(401);
    expect(senhaErrada.body).toEqual(semUsuario.body);
  });

  it("/me sem cookie ou com cookie inválido dá 401", async () => {
    const { app } = newApp();
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    const falso = await request(app).get("/api/auth/me").set("Cookie", "concord_session=lixo");
    expect(falso.status).toBe(401);
  });

  it("logout limpa a sessão", async () => {
    const agent = request.agent(newApp().app);
    await agent.post("/api/auth/register").send(ana);
    expect((await agent.post("/api/auth/logout")).status).toBe(204);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });
});
