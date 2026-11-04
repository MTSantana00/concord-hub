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

describe("servidores", () => {
  it("exige login", async () => {
    const { app } = newApp();
    expect((await request(app).get("/api/servers")).status).toBe(401);
    expect((await request(app).post("/api/servers").send({ name: "x" })).status).toBe(401);
  });

  it("cria o servidor já com o canal #geral e o criador como dono e membro", async () => {
    const { app, db } = newApp();
    const ana = await login(app, "ana");

    const res = await ana.post("/api/servers").send({ name: "  Os Parças  " });
    expect(res.status).toBe(201);
    expect(res.body.server.name).toBe("Os Parças");
    expect(res.body.server.channels.map((c: { name: string }) => c.name)).toEqual(["geral"]);

    const members = db.prepare("SELECT COUNT(*) AS n FROM members").get() as { n: number };
    expect(members.n).toBe(1);
  });

  it("lista os servidores do usuário com seus canais", async () => {
    const { app } = newApp();
    const ana = await login(app, "ana");
    await ana.post("/api/servers").send({ name: "Um" });
    await ana.post("/api/servers").send({ name: "Dois" });

    const res = await ana.get("/api/servers");
    expect(res.status).toBe(200);
    expect(res.body.servers.map((s: { name: string }) => s.name)).toEqual(["Um", "Dois"]);
    expect(res.body.servers[0].channels[0].name).toBe("geral");
  });

  it("nunca mostra servidores de onde o usuário não é membro", async () => {
    const { app } = newApp();
    const ana = await login(app, "ana");
    const beto = await login(app, "beto");
    await ana.post("/api/servers").send({ name: "Só da Ana" });

    expect((await beto.get("/api/servers")).body.servers).toEqual([]);
  });

  it("valida o nome", async () => {
    const { app, db } = newApp();
    const ana = await login(app, "ana");
    const vazio = await ana.post("/api/servers").send({ name: "   " });
    const grande = await ana.post("/api/servers").send({ name: "x".repeat(51) });
    const tipo = await ana.post("/api/servers").send({ name: { a: 1 } });
    expect([vazio.status, grande.status, tipo.status]).toEqual([400, 400, 400]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM servers").get() as { n: number }).n).toBe(0);
  });
});
