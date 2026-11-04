import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, scenario, signup } from "./testkit.js";

afterEach(closeAll);

/** Ana (dona), Beto (membro), Dani (membro, moderador), Carla de fora. */
async function withMods() {
  const s = await scenario();
  const base = `/api/servers/${s.server.id}`;
  const dani = await signup(s.app, "dani");
  await dani.agent.post(`/api/invites/${s.code}/join`);
  const roles = (await s.ana.agent.get(`${base}/roles`)).body.roles as { id: number; name: string }[];
  const cargo = (n: string) => roles.find((r) => r.name === n)!.id;
  const darCargo = (userId: number, name: string) => s.ana.agent.put(`${base}/members/${userId}/role`).send({ roleId: cargo(name) });
  await darCargo(dani.id, "Moderador");
  const membros = async () => ((await s.ana.agent.get(`${base}/members`)).body.members as { username: string }[]).map((m) => m.username);
  return { ...s, dani, base, darCargo, membros };
}

describe("expulsar", () => {
  it("o moderador expulsa um membro comum; ele sai da lista, perde o acesso e é avisado", async () => {
    const { dani, beto, port, base, channelId, membros } = await withMods();
    const wsBeto = await connect(port, { Cookie: beto.cookie }, { presence: true });
    const url = `/api/channels/${channelId}/messages`;
    expect((await beto.agent.get(url)).status).toBe(200);

    expect((await dani.agent.delete(`${base}/members/${beto.id}`)).status).toBe(204);
    expect(await membros()).not.toContain("beto");
    expect((await beto.agent.get(url)).status).toBe(404);
    const evento = await wsBeto.next();
    expect(evento).toMatchObject({ type: "member.removed", userId: beto.id, reason: "kicked" });
  });

  it("quem não tem kick_ban recebe 403; de fora 404; não dá para expulsar a si, o dono, outro moderador nem quem não é membro", async () => {
    const { ana, beto, carla, dani, base } = await withMods();
    expect((await beto.agent.delete(`${base}/members/${dani.id}`)).status).toBe(403);
    expect((await carla.agent.delete(`${base}/members/${beto.id}`)).status).toBe(404);
    expect((await dani.agent.delete(`${base}/members/${dani.id}`)).status).toBe(400);
    expect((await dani.agent.delete(`${base}/members/${ana.id}`)).status).toBe(403);
    expect((await dani.agent.delete(`${base}/members/${carla.id}`)).status).toBe(404);
    expect((await dani.agent.delete(`${base}/members/abc`)).status).toBe(404);
  });

  it("só o dono expulsa um moderador", async () => {
    const { ana, beto, dani, base, darCargo, membros } = await withMods();
    await darCargo(beto.id, "Moderador");
    expect((await dani.agent.delete(`${base}/members/${beto.id}`)).status).toBe(403);
    expect((await ana.agent.delete(`${base}/members/${beto.id}`)).status).toBe(204);
    expect(await membros()).not.toContain("beto");
  });

  it("expulsar tira a pessoa da sala de voz do servidor", async () => {
    const { ana, beto, dani, port, base } = await withMods();
    const sala = (await ana.agent.post(`${base}/channels`).send({ name: "sala", type: "voice" })).body.channel.id;
    const ws = await connect(port, { Cookie: beto.cookie });
    const wsAna = await connect(port, { Cookie: ana.cookie });
    ws.ws.send(JSON.stringify({ type: "voice.join", channelId: sala }));
    await wsAna.next();
    await dani.agent.delete(`${base}/members/${beto.id}`);
    const tipos = [(await wsAna.next()).type, (await wsAna.next()).type].sort();
    expect(tipos).toEqual(["member.removed", "voice.left"]);
    expect((await ana.agent.get(`${base}/voice`)).body.participants).toEqual([]);
  });
});

describe("banir e desbanir", () => {
  it("o banido sai, não volta com um convite novo e aparece na lista de banidos", async () => {
    const { ana, beto, dani, base, membros } = await withMods();
    const ban = await dani.agent.post(`${base}/bans`).send({ userId: beto.id, reason: "  spam  " });
    expect(ban.status).toBe(201);
    expect(await membros()).not.toContain("beto");

    const novo = (await ana.agent.post(`${base}/invites`)).body.code;
    const volta = await beto.agent.post(`/api/invites/${novo}/join`);
    expect(volta.status).toBe(403);
    expect(volta.body.error).toContain("banido");

    const lista = (await dani.agent.get(`${base}/bans`)).body.bans;
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ userId: beto.id, username: "beto", bannedBy: "dani" });
  });

  it("desbanir permite voltar; sem permissão não vê nem desbane", async () => {
    const { ana, beto, dani, base, membros } = await withMods();
    await ana.agent.post(`${base}/bans`).send({ userId: beto.id });
    expect((await beto.agent.get(`${base}/bans`)).status).toBe(404); // não é mais membro
    expect((await dani.agent.delete(`${base}/bans/${beto.id}`)).status).toBe(204);
    expect((await dani.agent.delete(`${base}/bans/${beto.id}`)).status).toBe(404);
    const novo = (await ana.agent.post(`${base}/invites`)).body.code;
    expect((await beto.agent.post(`/api/invites/${novo}/join`)).status).toBe(200);
    expect(await membros()).toContain("beto");
    expect((await beto.agent.get(`${base}/bans`)).status).toBe(403);
    expect((await beto.agent.delete(`${base}/bans/${dani.id}`)).status).toBe(403);
  });

  it("não dá para banir o dono nem a si mesmo, e dados inválidos são recusados", async () => {
    const { ana, dani, base } = await withMods();
    expect((await dani.agent.post(`${base}/bans`).send({ userId: ana.id })).status).toBe(403);
    expect((await dani.agent.post(`${base}/bans`).send({ userId: dani.id })).status).toBe(400);
    expect((await dani.agent.post(`${base}/bans`).send({})).status).toBe(404);
    expect((await dani.agent.post(`${base}/bans`).send({ userId: 9999 })).status).toBe(404);
  });
});

describe("sair do servidor", () => {
  it("um membro sai por conta própria; o dono não pode", async () => {
    const { ana, beto, base, membros } = await withMods();
    expect((await ana.agent.post(`${base}/leave`)).status).toBe(400);
    expect((await beto.agent.post(`${base}/leave`)).status).toBe(204);
    expect(await membros()).not.toContain("beto");
    expect((await beto.agent.post(`${base}/leave`)).status).toBe(404);
  });
});

describe("log de ações", () => {
  it("registra convites, cargos, expulsões, banimentos e mensagens apagadas, com texto legível", async () => {
    const { ana, beto, dani, base, channelId, darCargo } = await withMods();
    const convite = (await ana.agent.post(`${base}/invites`)).body.code;
    await ana.agent.delete(`${base}/invites/${convite}`);
    await darCargo(beto.id, "Convidador");
    const msg = (await beto.agent.post(`/api/channels/${channelId}/messages`).send({ content: "oi" })).body.message;
    await dani.agent.delete(`/api/channels/${channelId}/messages/${msg.id}`);
    await dani.agent.delete(`${base}/members/${beto.id}`);

    const log = (await dani.agent.get(`${base}/log`)).body.entries as { text: string; action: string }[];
    const textos = log.map((e) => e.text);
    expect(textos).toContain("dani expulsou beto");
    expect(textos).toContain("dani apagou uma mensagem de beto");
    expect(textos).toContain("ana mudou o cargo de beto (Convidador)");
    expect(textos).toContain("ana revogou um convite");
    expect(textos).toContain("ana criou um convite");
    expect(log[0].action).toBe("member.kicked"); // o mais recente primeiro
  });

  it("só quem tem view_log vê; de fora 404", async () => {
    const { beto, carla, base } = await withMods();
    expect((await beto.agent.get(`${base}/log`)).status).toBe(403);
    expect((await carla.agent.get(`${base}/log`)).status).toBe(404);
  });
});
