import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

async function login(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  await agent.post("/api/auth/register").send({ username, password: "senha-bem-longa" });
  return agent;
}

async function setup() {
  const db = openDb();
  const app = createApp({ db, jwtSecret: "teste", secureCookies: false });
  const ana = await login(app, "ana");
  const beto = await login(app, "beto");
  const carla = await login(app, "carla"); // nunca entra no servidor
  const server = (await ana.post("/api/servers").send({ name: "Os Parças" })).body.server;
  const { code } = (await ana.post(`/api/servers/${server.id}/invites`)).body;
  await beto.post(`/api/invites/${code}/join`);
  return { app, ana, beto, carla, server };
}

const names = (body: { channels: { name: string }[] }) => body.channels.map((c) => c.name);

describe("canais", () => {
  it("o dono cria um canal e os membros o veem na lista", async () => {
    const { ana, beto, server } = await setup();

    const res = await ana.post(`/api/servers/${server.id}/channels`).send({ name: "jogos" });
    expect(res.status).toBe(201);
    expect(res.body.channel.name).toBe("jogos");

    for (const user of [ana, beto]) {
      const list = await user.get(`/api/servers/${server.id}/channels`);
      expect(list.status).toBe(200);
      expect(names(list.body)).toEqual(["geral", "jogos"]);
    }
  });

  it("normaliza o nome: minúsculas, espaços viram hífen, aceita acentos", async () => {
    const { ana, server } = await setup();
    const a = await ana.post(`/api/servers/${server.id}/channels`).send({ name: "  Papo Furado  " });
    const b = await ana.post(`/api/servers/${server.id}/channels`).send({ name: "Música" });
    expect(a.body.channel.name).toBe("papo-furado");
    expect(b.body.channel.name).toBe("música");
  });

  it("rejeita nomes inválidos", async () => {
    const { ana, server } = await setup();
    const url = `/api/servers/${server.id}/channels`;
    const results = await Promise.all(
      ["", "   ", "a".repeat(31), "oi!", "<script>", "a/b"].map((name) => ana.post(url).send({ name })),
    );
    expect(results.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400]);
    expect((await ana.post(url).send({ name: { a: 1 } })).status).toBe(400);
    expect((await ana.post(url).send({})).status).toBe(400);
  });

  it("nome repetido no mesmo servidor dá 409 (mesmo com maiúsculas)", async () => {
    const { ana, server } = await setup();
    const url = `/api/servers/${server.id}/channels`;
    expect((await ana.post(url).send({ name: "geral" })).status).toBe(409);
    expect((await ana.post(url).send({ name: "GERAL" })).status).toBe(409);
  });

  it("o mesmo nome pode existir em servidores diferentes", async () => {
    const { ana, beto, server } = await setup();
    const outro = (await beto.post("/api/servers").send({ name: "Do Beto" })).body.server;
    expect((await beto.post(`/api/servers/${outro.id}/channels`).send({ name: "jogos" })).status).toBe(201);
    expect((await ana.post(`/api/servers/${server.id}/channels`).send({ name: "jogos" })).status).toBe(201);
  });

  it("membro que não é dono não cria canal (403)", async () => {
    const { beto, server } = await setup();
    const res = await beto.post(`/api/servers/${server.id}/channels`).send({ name: "jogos" });
    expect(res.status).toBe(403);
  });

  it("quem não é membro não lista nem cria (404)", async () => {
    const { carla, server } = await setup();
    expect((await carla.get(`/api/servers/${server.id}/channels`)).status).toBe(404);
    expect((await carla.post(`/api/servers/${server.id}/channels`).send({ name: "jogos" })).status).toBe(404);
  });

  it("id de servidor inválido dá 404", async () => {
    const { ana } = await setup();
    expect((await ana.get("/api/servers/abc/channels")).status).toBe(404);
    expect((await ana.get("/api/servers/9999/channels")).status).toBe(404);
  });

  it("exige login", async () => {
    const { app, server } = await setup();
    expect((await request(app).get(`/api/servers/${server.id}/channels`)).status).toBe(401);
    expect((await request(app).post(`/api/servers/${server.id}/channels`).send({ name: "x" })).status).toBe(401);
  });

  it("a lista de servidores inclui os canais novos", async () => {
    const { ana, server } = await setup();
    await ana.post(`/api/servers/${server.id}/channels`).send({ name: "jogos" });
    const list = await ana.get("/api/servers");
    expect(list.body.servers[0].channels.map((c: { name: string }) => c.name)).toEqual(["geral", "jogos"]);
  });
});
