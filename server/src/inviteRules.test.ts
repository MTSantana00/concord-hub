import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, scenario, signup, start } from "./testkit.js";

afterEach(closeAll);

/** Ana (dona), Beto (membro comum), Carla de fora e Dani (de fora); o Beto ainda não pode convidar. */
async function withInvites() {
  const s = await scenario();
  const dani = await signup(s.app, "dani");
  const base = `/api/servers/${s.server.id}`;
  const roles = (await s.ana.agent.get(`${base}/roles`)).body.roles as { id: number; name: string }[];
  const cargo = (n: string) => roles.find((r) => r.name === n)!.id;
  const darCargo = (userId: number, name: string) => s.ana.agent.put(`${base}/members/${userId}/role`).send({ roleId: cargo(name) });
  return { ...s, dani, base, darCargo };
}

describe("quem pode criar convites", () => {
  it("só quem tem o cargo certo; quem é de fora leva 404", async () => {
    const { ana, beto, carla, base, darCargo } = await withInvites();
    expect((await beto.agent.post(`${base}/invites`)).status).toBe(403); // Membro não convida
    expect((await carla.agent.post(`${base}/invites`)).status).toBe(404);
    await darCargo(beto.id, "Convidador");
    const res = await beto.agent.post(`${base}/invites`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ limit: 10, used: 1, remaining: 9 });
    expect(res.body.code.length).toBeGreaterThanOrEqual(10);
    expect((await ana.agent.post(`${base}/invites`)).status).toBe(201); // o dono também
  });

  it("perder o cargo tira o direito de convidar", async () => {
    const { beto, base, darCargo } = await withInvites();
    await darCargo(beto.id, "Convidador");
    expect((await beto.agent.post(`${base}/invites`)).status).toBe(201);
    await darCargo(beto.id, "Membro");
    expect((await beto.agent.post(`${base}/invites`)).status).toBe(403);
  });
});

describe("cada convite vale uma vez só", () => {
  it("o primeiro a usar entra; o segundo recebe 410; quem já entrou não gasta nada", async () => {
    const { ana, carla, dani, base, server } = await withInvites();
    const { code } = (await ana.agent.post(`${base}/invites`)).body;

    expect((await carla.agent.post(`/api/invites/${code}/join`)).status).toBe(200);
    const segundo = await dani.agent.post(`/api/invites/${code}/join`);
    expect(segundo.status).toBe(410);
    expect(segundo.body.error).toContain("já foi usado");

    // quem já é membro "entra de novo" sem erro
    expect((await carla.agent.post(`/api/invites/${code}/join`)).status).toBe(200);
    const members = (await ana.agent.get(`/api/servers/${server.id}/members`)).body.members.map((m: any) => m.username);
    expect(members).toContain("carla");
    expect(members).not.toContain("dani");
  });

  it("quem já é membro usando outro convite não o consome", async () => {
    const { ana, beto, dani, base } = await withInvites();
    const { code } = (await ana.agent.post(`${base}/invites`)).body;
    expect((await beto.agent.post(`/api/invites/${code}/join`)).status).toBe(200); // já era membro
    expect((await dani.agent.post(`/api/invites/${code}/join`)).status).toBe(200); // o convite ainda estava livre
  });

  it("convite inexistente ou revogado é 404", async () => {
    const { ana, carla, base } = await withInvites();
    expect((await carla.agent.post(`/api/invites/nao-existe/join`)).status).toBe(404);
    const { code } = (await ana.agent.post(`${base}/invites`)).body;
    await ana.agent.delete(`${base}/invites/${code}`);
    expect((await carla.agent.post(`/api/invites/${code}/join`)).status).toBe(404);
  });
});

describe("limite de 10 convites por pessoa", () => {
  it("o 11º é recusado (429); revogar um que não foi usado devolve a vaga; um usado não devolve", async () => {
    const { ana, carla, base } = await withInvites();
    // a dona já criou 2 no cenário (o do Beto e um reserva); cria mais 8 até o limite de 10
    const codes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await ana.agent.post(`${base}/invites`);
      expect(r.status).toBe(201);
      codes.push(r.body.code);
    }
    const cheio = await ana.agent.post(`${base}/invites`);
    expect(cheio.status).toBe(429);
    expect(cheio.body.error).toContain("10 convites");

    expect((await ana.agent.delete(`${base}/invites/${codes[0]}`)).status).toBe(204);
    expect((await ana.agent.post(`${base}/invites`)).status).toBe(201); // vaga devolvida
    expect((await ana.agent.post(`${base}/invites`)).status).toBe(429);

    // usar um convite não devolve a vaga: quem foi convidado conta para sempre
    await carla.agent.post(`/api/invites/${codes[1]}/join`);
    expect((await ana.agent.post(`${base}/invites`)).status).toBe(429);
  });

  it("o limite é por pessoa: o convite da Beto não gasta o da Ana", async () => {
    const { ana, beto, base, darCargo } = await withInvites();
    await darCargo(beto.id, "Convidador");
    for (let i = 0; i < 10; i++) expect((await beto.agent.post(`${base}/invites`)).status).toBe(201);
    expect((await beto.agent.post(`${base}/invites`)).status).toBe(429);
    expect((await ana.agent.post(`${base}/invites`)).status).toBe(201);
  });

  it("o limite vale somando todos os servidores da pessoa", async () => {
    const { ana, base } = await withInvites();
    const outro = (await ana.agent.post("/api/servers").send({ name: "Outro" })).body.server;
    for (let i = 0; i < 5; i++) await ana.agent.post(`${base}/invites`); // 2 do cenário + 5 = 7
    for (let i = 0; i < 3; i++) expect((await ana.agent.post(`/api/servers/${outro.id}/invites`)).status).toBe(201);
    expect((await ana.agent.post(`/api/servers/${outro.id}/invites`)).status).toBe(429);
  });

  it("o limite pode ser configurado", async () => {
    const { app } = await start({ inviteLimit: 2 });
    const ana = await signup(app, "ana");
    const server = (await ana.agent.post("/api/servers").send({ name: "S" })).body.server;
    expect((await ana.agent.post(`/api/servers/${server.id}/invites`)).status).toBe(201);
    expect((await ana.agent.post(`/api/servers/${server.id}/invites`)).status).toBe(201);
    expect((await ana.agent.post(`/api/servers/${server.id}/invites`)).status).toBe(429);
  });
});

describe("painel de convites", () => {
  it("cada um vê só os seus, com status; quem gerencia convites vê todos", async () => {
    const { ana, beto, carla, base, darCargo } = await withInvites();
    await darCargo(beto.id, "Convidador");
    const doBeto = (await beto.agent.post(`${base}/invites`)).body.code;
    const outro = (await beto.agent.post(`${base}/invites`)).body.code;
    await beto.agent.delete(`${base}/invites/${outro}`);
    await carla.agent.post(`/api/invites/${doBeto}/join`);

    const meus = (await beto.agent.get(`${base}/invites`)).body;
    expect(meus).toMatchObject({ limit: 10, used: 1, remaining: 9, canSeeAll: false });
    const status = Object.fromEntries(meus.invites.map((i: any) => [i.code, i.status]));
    expect(status).toEqual({ [doBeto]: "used", [outro]: "revoked" });
    expect(meus.invites.find((i: any) => i.code === doBeto).usedBy.username).toBe("carla");
    expect(meus.invites.every((i: any) => i.createdBy.username === "beto")).toBe(true);

    const todos = (await ana.agent.get(`${base}/invites`)).body;
    expect(todos.canSeeAll).toBe(true);
    expect(todos.invites.map((i: any) => i.createdBy.username)).toContain("beto");
    expect(todos.invites.map((i: any) => i.createdBy.username)).toContain("ana");
  });

  it("membro sem cargo de convite não vê o painel; de fora leva 404", async () => {
    const { beto, carla, base } = await withInvites();
    expect((await beto.agent.get(`${base}/invites`)).status).toBe(403);
    expect((await carla.agent.get(`${base}/invites`)).status).toBe(404);
  });
});

describe("revogar convites", () => {
  it("o criador revoga o seu; os outros só com permissão; um convite usado não se revoga", async () => {
    const { ana, beto, dani, carla, base, darCargo } = await withInvites();
    await darCargo(beto.id, "Convidador");
    await darCargo(dani.id, "Convidador");
    const doBeto = (await beto.agent.post(`${base}/invites`)).body.code;
    expect((await ana.agent.get(`${base}/members`)).status).toBe(200);

    // Dani não é do servidor ainda
    expect((await dani.agent.delete(`${base}/invites/${doBeto}`)).status).toBe(404);
    // entra e vira convidadora: ainda assim não revoga o convite de outro
    const entrada = (await ana.agent.post(`${base}/invites`)).body.code;
    await dani.agent.post(`/api/invites/${entrada}/join`);
    await darCargo(dani.id, "Convidador");
    expect((await dani.agent.delete(`${base}/invites/${doBeto}`)).status).toBe(403);

    // a dona (manage_invites) revoga o convite do Beto
    expect((await ana.agent.delete(`${base}/invites/${doBeto}`)).status).toBe(204);
    expect((await ana.agent.delete(`${base}/invites/${doBeto}`)).status).toBe(404); // já revogado

    const usado = (await beto.agent.post(`${base}/invites`)).body.code;
    await carla.agent.post(`/api/invites/${usado}/join`);
    const r = await beto.agent.delete(`${base}/invites/${usado}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("já foi usado");
  });
});

describe("cadastro com convite de uso único (servidor fechado)", () => {
  const setupCode = "codigo-de-setup-123";

  async function servidorFechado() {
    const { app, port } = await start({ inviteOnly: true, setupCode });
    const ana = request.agent(app);
    await ana.post("/api/auth/register").send({ username: "ana", password: "senha-bem-longa", inviteCode: setupCode });
    const server = (await ana.post("/api/servers").send({ name: "Os Parças" })).body.server;
    const novoConvite = async () => (await ana.post(`/api/servers/${server.id}/invites`)).body.code as string;
    return { app, port, ana, server, novoConvite };
  }

  it("o convite é gasto no cadastro: a pessoa já entra no servidor com o cargo padrão; o segundo cadastro recebe 410", async () => {
    const { app, ana, server, novoConvite } = await servidorFechado();
    const code = await novoConvite();

    const beto = request.agent(app);
    const ok = await beto.post("/api/auth/register").send({ username: "beto", password: "senha-bem-longa", inviteCode: code });
    expect(ok.status).toBe(201);
    const servers = (await beto.get("/api/servers")).body.servers;
    expect(servers.map((s: any) => s.id)).toEqual([server.id]);
    const members = (await ana.get(`/api/servers/${server.id}/members`)).body.members;
    expect(members.find((m: any) => m.username === "beto").roleName).toBe("Membro");

    const carla = await request(app).post("/api/auth/register").send({ username: "carla", password: "senha-bem-longa", inviteCode: code });
    expect(carla.status).toBe(410);
    expect(carla.body.error).toContain("já foi usado");
    expect((await request(app).post("/api/auth/login").send({ username: "carla", password: "senha-bem-longa" })).status).toBe(401); // conta não ficou pela metade
  });

  it("convite revogado não cadastra ninguém, e depois do cadastro o 'join' do mesmo link continua dando certo", async () => {
    const { app, ana, server, novoConvite } = await servidorFechado();
    const revogado = await novoConvite();
    await ana.delete(`/api/servers/${server.id}/invites/${revogado}`);
    expect((await request(app).post("/api/auth/register").send({ username: "x1", password: "senha-bem-longa", inviteCode: revogado })).status).toBe(403);

    const code = await novoConvite();
    const beto = request.agent(app);
    await beto.post("/api/auth/register").send({ username: "beto", password: "senha-bem-longa", inviteCode: code });
    const join = await beto.post(`/api/invites/${code}/join`); // o cliente chama isso logo depois do cadastro
    expect(join.status).toBe(200);
    expect(join.body.server.id).toBe(server.id);
  });

  it("os membros veem a pessoa entrar em tempo real", async () => {
    const { app, port, ana, server, novoConvite } = await servidorFechado();
    void ana;
    const dono = await request(app).post("/api/auth/login").send({ username: "ana", password: "senha-bem-longa" });
    const ws = await connect(port, { Cookie: String(dono.headers["set-cookie"][0]).split(";")[0] }, { presence: true });
    const code = await novoConvite();
    await request(app).post("/api/auth/register").send({ username: "beto", password: "senha-bem-longa", inviteCode: code });
    const evento = await ws.next();
    expect(evento).toMatchObject({ type: "member.joined", serverId: server.id, member: { username: "beto", roleName: "Membro" } });
  });

  it("a primeira conta vira administradora da plataforma; as seguintes não", async () => {
    const { app, ana, novoConvite } = await servidorFechado();
    void ana;
    const code = await novoConvite();
    await request(app).post("/api/auth/register").send({ username: "beto", password: "senha-bem-longa", inviteCode: code });
    const db = (app.locals.hub as { db: { prepare(s: string): { all(): unknown[] } } }).db;
    const rows = db.prepare("SELECT username, is_admin FROM users ORDER BY id").all() as { username: string; is_admin: number }[];
    expect(rows).toEqual([
      { username: "ana", is_admin: 1 },
      { username: "beto", is_admin: 0 },
    ]);
  });
});
