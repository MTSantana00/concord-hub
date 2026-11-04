import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, rejectedStatus, scenario, start } from "./testkit.js";

afterEach(closeAll);

const login = (app: Parameters<typeof request>[0], username: string, password: string) =>
  request(app).post("/api/auth/login").send({ username, password });

describe("trocar a própria senha", () => {
  it("pede a senha atual, vale para o próximo login e derruba os outros aparelhos, mantendo este", async () => {
    const { app, ana } = await scenario();
    // um "segundo aparelho" da Ana, logado antes da troca
    const outroAparelho = await login(app, "ana", "senha-bem-longa");
    const cookieAntigo = String(outroAparelho.headers["set-cookie"][0]).split(";")[0];

    const troca = await ana.agent.post("/api/auth/password").send({ current: "senha-bem-longa", next: "outra-senha-forte" });
    expect(troca.status).toBe(204);

    expect((await ana.agent.get("/api/auth/me")).status).toBe(200); // este aparelho continua logado
    expect((await request(app).get("/api/auth/me").set("Cookie", cookieAntigo)).status).toBe(401); // o outro caiu
    expect((await login(app, "ana", "senha-bem-longa")).status).toBe(401);
    expect((await login(app, "ana", "outra-senha-forte")).status).toBe(200);
  });

  it("recusa senha atual errada, nova igual à atual, nova curta ou dados faltando", async () => {
    const { ana } = await scenario();
    expect((await ana.agent.post("/api/auth/password").send({ current: "errada-errada", next: "outra-senha-forte" })).status).toBe(403);
    expect((await ana.agent.post("/api/auth/password").send({ current: "senha-bem-longa", next: "senha-bem-longa" })).status).toBe(400);
    expect((await ana.agent.post("/api/auth/password").send({ current: "senha-bem-longa", next: "curta" })).status).toBe(400);
    expect((await ana.agent.post("/api/auth/password").send({ current: "senha-bem-longa" })).status).toBe(400);
    expect((await ana.agent.post("/api/auth/password").send({ current: "senha-bem-longa", next: "x".repeat(73) })).status).toBe(400);
  });

  it("sem login é 401", async () => {
    const { app } = await scenario();
    expect((await request(app).post("/api/auth/password").send({ current: "a", next: "b" })).status).toBe(401);
  });
});

describe("sair de todos os aparelhos", () => {
  it("derruba os outros logins (e o WebSocket deles), mas este aparelho segue", async () => {
    const { app, port, ana } = await scenario();
    const outro = await login(app, "ana", "senha-bem-longa");
    const cookieOutro = String(outro.headers["set-cookie"][0]).split(";")[0];
    expect((await request(app).get("/api/auth/me").set("Cookie", cookieOutro)).status).toBe(200);

    expect((await ana.agent.post("/api/auth/logout-all")).status).toBe(204);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookieOutro)).status).toBe(401);
    expect(await rejectedStatus(port, { Cookie: cookieOutro })).toBe(401);
    expect((await ana.agent.get("/api/auth/me")).status).toBe(200);
  });

  it("sem login é 401", async () => {
    const { app } = await scenario();
    expect((await request(app).post("/api/auth/logout-all")).status).toBe(401);
  });
});

describe("administradora redefine a senha de um amigo", () => {
  /** Ana (primeira conta = administradora) e Beto. */
  async function admin() {
    const { app, ana, beto } = await start().then(async ({ app }) => {
      const { signup } = await import("./testkit.js");
      const ana = await signup(app, "ana");
      const beto = await signup(app, "beto");
      return { app, ana, beto };
    });
    return { app, ana, beto };
  }

  it("a primeira conta é administradora e as outras não; /me informa", async () => {
    const { ana, beto } = await admin();
    expect((await ana.agent.get("/api/auth/me")).body.user).toMatchObject({ isAdmin: true, mustChangePassword: false });
    expect((await beto.agent.get("/api/auth/me")).body.user).toMatchObject({ isAdmin: false });
  });

  it("gera uma senha temporária: o amigo entra com ela, é obrigado a trocar, e a senha antiga e os logins antigos caem", async () => {
    const { app, ana, beto } = await admin();
    const r = await ana.agent.post("/api/auth/admin/reset-password").send({ userId: beto.id });
    expect(r.status).toBe(200);
    expect(r.body.username).toBe("beto");
    expect(r.body.tempPassword.length).toBeGreaterThanOrEqual(10);

    expect((await beto.agent.get("/api/auth/me")).status).toBe(401); // o login antigo caiu
    expect((await login(app, "beto", "senha-bem-longa")).status).toBe(401);
    const entrada = await login(app, "beto", r.body.tempPassword);
    expect(entrada.status).toBe(200);
    expect(entrada.body.user.mustChangePassword).toBe(true);

    const cookie = String(entrada.headers["set-cookie"][0]).split(";")[0];
    const troca = await request(app).post("/api/auth/password").set("Cookie", cookie).send({ current: r.body.tempPassword, next: "senha-do-beto-nova" });
    expect(troca.status).toBe(204);
    expect((await request(app).get("/api/auth/me").set("Cookie", String(troca.headers["set-cookie"][0]).split(";")[0])).body.user.mustChangePassword).toBe(false);
  });

  it("quem não é administrador recebe 403; usuário inexistente 404; ela mesma 400", async () => {
    const { ana, beto } = await admin();
    expect((await beto.agent.post("/api/auth/admin/reset-password").send({ userId: ana.id })).status).toBe(403);
    expect((await ana.agent.post("/api/auth/admin/reset-password").send({ userId: 9999 })).status).toBe(404);
    expect((await ana.agent.post("/api/auth/admin/reset-password").send({})).status).toBe(404);
    expect((await ana.agent.post("/api/auth/admin/reset-password").send({ userId: ana.id })).status).toBe(400);
  });

  it("o dono de um servidor que não é administrador não consegue redefinir a senha de ninguém", async () => {
    const { beto, ana } = await admin();
    await beto.agent.post("/api/servers").send({ name: "Do Beto" });
    expect((await beto.agent.post("/api/auth/admin/reset-password").send({ userId: ana.id })).status).toBe(403);
  });
});
