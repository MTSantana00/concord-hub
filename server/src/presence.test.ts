import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, pause, scenario, signup } from "./testkit.js";

afterEach(closeAll);

const WITH_PRESENCE = { presence: true };

describe("lista de membros", () => {
  it("lista os membros em ordem alfabética, com o dono marcado", async () => {
    const { beto, server } = await scenario();
    const res = await beto.agent.get(`/api/servers/${server.id}/members`);
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: any) => [m.username, m.isOwner])).toEqual([
      ["ana", true],
      ["beto", false],
    ]);
  });

  it("mostra quem está conectado como online", async () => {
    const { port, ana, beto, server } = await scenario();
    await connect(port, { Cookie: beto.cookie }, WITH_PRESENCE);

    const res = await ana.agent.get(`/api/servers/${server.id}/members`);
    expect(res.body.members.map((m: any) => [m.username, m.online])).toEqual([
      ["ana", false],
      ["beto", true],
    ]);
  });

  it("quem não é membro não vê a lista (404); sem login, 401", async () => {
    const { app, carla, server } = await scenario();
    expect((await carla.agent.get(`/api/servers/${server.id}/members`)).status).toBe(404);
    expect((await request(app).get(`/api/servers/${server.id}/members`)).status).toBe(401);
    expect((await carla.agent.get("/api/servers/abc/members")).status).toBe(404);
  });

  it("não vaza senha nem dados além do necessário", async () => {
    const { ana, server } = await scenario();
    const { body } = await ana.agent.get(`/api/servers/${server.id}/members`);
    expect(Object.keys(body.members[0]).sort()).toEqual(["about", "avatarVersion", "displayName", "id", "isOwner", "nickname", "online", "roleId", "roleName", "statusKind", "statusText", "timeoutUntil", "username"]);
  });
});

describe("presença em tempo real", () => {
  it("avisa os outros membros quando alguém conecta e quando desconecta", async () => {
    const { port, ana, beto } = await scenario();
    const wsAna = await connect(port, { Cookie: ana.cookie }, WITH_PRESENCE);
    const wsBeto = await connect(port, { Cookie: beto.cookie }, WITH_PRESENCE);

    // Ana já estava conectada: vê o Beto ficar online
    const on = await wsAna.next();
    expect(on).toEqual({ type: "presence.updated", userId: beto.id, online: true });

    await wsBeto.close();
    expect(await wsAna.next()).toEqual({ type: "presence.updated", userId: beto.id, online: false });
  });

  it("várias abas: só fica offline quando a última fecha", async () => {
    const { port, ana, beto, server } = await scenario();
    const wsAna = await connect(port, { Cookie: ana.cookie }, WITH_PRESENCE);
    const aba1 = await connect(port, { Cookie: beto.cookie }, WITH_PRESENCE);
    const aba2 = await connect(port, { Cookie: beto.cookie }, WITH_PRESENCE);
    expect((await wsAna.next()).online).toBe(true); // só um aviso, apesar de duas abas

    await aba1.close();
    await pause(150);
    expect(wsAna.received).toEqual([]); // ainda tem a aba 2
    const lista = await ana.agent.get(`/api/servers/${server.id}/members`);
    expect(lista.body.members.find((m: any) => m.username === "beto").online).toBe(true);

    await aba2.close();
    expect(await wsAna.next()).toEqual({ type: "presence.updated", userId: beto.id, online: false });
  });

  it("quem não divide servidor com a pessoa não recebe o aviso", async () => {
    const { port, ana, beto, carla } = await scenario();
    const wsCarla = await connect(port, { Cookie: carla.cookie }, WITH_PRESENCE);
    const wsAna = await connect(port, { Cookie: ana.cookie }, WITH_PRESENCE);
    await connect(port, { Cookie: beto.cookie }, WITH_PRESENCE);
    await wsAna.next(); // Ana viu o Beto ficar online

    await pause(150);
    expect(wsCarla.received).toEqual([]);
  });

  it("recarregar a página dentro da carência não pisca como offline", async () => {
    const { port, ana, beto, server } = await scenario({ offlineGraceMs: 300 });
    const wsAna = await connect(port, { Cookie: ana.cookie }, WITH_PRESENCE);
    const antes = await connect(port, { Cookie: beto.cookie }, WITH_PRESENCE);
    expect((await wsAna.next()).online).toBe(true);

    await antes.close(); // a página recarrega...
    const lista = await ana.agent.get(`/api/servers/${server.id}/members`);
    expect(lista.body.members.find((m: any) => m.username === "beto").online).toBe(true); // ainda conta como online
    await connect(port, { Cookie: beto.cookie }, WITH_PRESENCE); // ...e volta logo

    await pause(500); // passa da carência
    expect(wsAna.received).toEqual([]); // nenhum "offline" nem "online" repetido
  });

  it("passada a carência sem voltar, anuncia offline", async () => {
    const { port, ana, beto } = await scenario({ offlineGraceMs: 200 });
    const wsAna = await connect(port, { Cookie: ana.cookie }, WITH_PRESENCE);
    const wsBeto = await connect(port, { Cookie: beto.cookie }, WITH_PRESENCE);
    await wsAna.next();
    await wsBeto.close();
    expect(await wsAna.next(1500)).toEqual({ type: "presence.updated", userId: beto.id, online: false });
  });
});

describe("novo membro", () => {
  it("quem está com o servidor aberto vê o novo membro entrar", async () => {
    const { app, port, ana, code } = await scenario();
    const wsAna = await connect(port, { Cookie: ana.cookie }, WITH_PRESENCE);
    const dani = await signup(app, "dani");

    await dani.agent.post(`/api/invites/${code}/join`);
    const event = await wsAna.next();
    expect(event.type).toBe("member.joined");
    expect(event.member).toMatchObject({ id: dani.id, username: "dani", online: false, isOwner: false, roleId: expect.any(Number), roleName: "Membro", displayName: null, avatarVersion: 0, statusKind: "online" });
  });

  it("usar o convite de novo não anuncia ninguém", async () => {
    const { port, ana, beto, code } = await scenario();
    const wsAna = await connect(port, { Cookie: ana.cookie }, WITH_PRESENCE);
    await beto.agent.post(`/api/invites/${code}/join`); // já era membro
    await ana.agent.post(`/api/invites/${code}/join`); // o dono também
    await pause(150);
    expect(wsAna.received).toEqual([]);
  });
});
