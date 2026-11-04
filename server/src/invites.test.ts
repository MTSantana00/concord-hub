import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

function newApp() {
  const db = openDb();
  return { db, app: createApp({ db, jwtSecret: "teste", secureCookies: false }) };
}

async function login(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  await agent.post("/api/auth/register").send({ username, password: "senha-bem-longa" });
  return agent;
}

async function setup() {
  const { app, db } = newApp();
  const ana = await login(app, "ana");
  const beto = await login(app, "beto");
  const server = (await ana.post("/api/servers").send({ name: "Os Parças" })).body.server;
  return { app, db, ana, beto, server };
}

describe("convites", () => {
  it("o dono gera um convite e o amigo entra pelo código", async () => {
    const { ana, beto, server } = await setup();

    const inv = await ana.post(`/api/servers/${server.id}/invites`);
    expect(inv.status).toBe(201);
    expect(inv.body.code.length).toBeGreaterThanOrEqual(10);

    const join = await beto.post(`/api/invites/${inv.body.code}/join`);
    expect(join.status).toBe(200);
    expect(join.body.server.name).toBe("Os Parças");
    expect(join.body.server.channels.map((c: { name: string }) => c.name)).toEqual(["geral"]);

    const list = await beto.get("/api/servers");
    expect(list.body.servers.map((s: { id: number }) => s.id)).toEqual([server.id]);
  });

  it("entrar duas vezes com o mesmo convite não duplica o membro", async () => {
    const { ana, beto, server, db } = await setup();
    const { code } = (await ana.post(`/api/servers/${server.id}/invites`)).body;

    expect((await beto.post(`/api/invites/${code}/join`)).status).toBe(200);
    expect((await beto.post(`/api/invites/${code}/join`)).status).toBe(200);

    const n = db.prepare("SELECT COUNT(*) AS n FROM members WHERE server_id = ?").get(server.id) as { n: number };
    expect(n.n).toBe(2); // dono + beto
  });

  it("o próprio dono usando o convite continua com um só registro", async () => {
    const { ana, server, db } = await setup();
    const { code } = (await ana.post(`/api/servers/${server.id}/invites`)).body;
    expect((await ana.post(`/api/invites/${code}/join`)).status).toBe(200);
    const n = db.prepare("SELECT COUNT(*) AS n FROM members WHERE server_id = ?").get(server.id) as { n: number };
    expect(n.n).toBe(1);
  });

  it("código inexistente dá 404", async () => {
    const { beto } = await setup();
    expect((await beto.post("/api/invites/codigo-que-nao-existe/join")).status).toBe(404);
  });

  it("membro que não é dono não gera convite (403)", async () => {
    const { ana, beto, server } = await setup();
    const { code } = (await ana.post(`/api/servers/${server.id}/invites`)).body;
    await beto.post(`/api/invites/${code}/join`);

    expect((await beto.post(`/api/servers/${server.id}/invites`)).status).toBe(403);
  });

  it("quem não é membro recebe 404 ao tentar gerar convite", async () => {
    const { beto, server } = await setup();
    expect((await beto.post(`/api/servers/${server.id}/invites`)).status).toBe(404);
  });

  it("id de servidor inválido dá 404", async () => {
    const { ana } = await setup();
    expect((await ana.post("/api/servers/abc/invites")).status).toBe(404);
    expect((await ana.post("/api/servers/9999/invites")).status).toBe(404);
  });

  it("exige login", async () => {
    const { app, server } = await setup();
    expect((await request(app).post(`/api/servers/${server.id}/invites`)).status).toBe(401);
    expect((await request(app).post("/api/invites/qualquer/join")).status).toBe(401);
  });
});
