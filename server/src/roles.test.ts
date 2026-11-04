import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, scenario } from "./testkit.js";

afterEach(closeAll);

/** Ana é a dona; Beto é membro com o cargo padrão ("Membro"); Carla é de fora. */
async function withRoles() {
  const s = await scenario();
  const base = `/api/servers/${s.server.id}`;
  const roles = (await s.ana.agent.get(`${base}/roles`)).body.roles as { id: number; name: string; permissions: string[]; isDefault: boolean; members: number }[];
  const byName = (n: string) => roles.find((r) => r.name === n)!;
  return { ...s, base, roles, byName };
}

describe("cargos iniciais e permissões de cada um", () => {
  it("todo servidor nasce com Membro (padrão), Convidador e Moderador", async () => {
    const { byName, roles } = await withRoles();
    expect(roles.map((r) => r.name)).toEqual(["Membro", "Convidador", "Moderador"]);
    expect(byName("Membro")).toMatchObject({ isDefault: true, permissions: [], members: 1 }); // o Beto
    expect(byName("Convidador").permissions).toEqual(["invite"]);
    expect(byName("Moderador").permissions).toEqual(["invite", "manage_invites", "manage_messages", "kick_ban", "manage_channels", "view_log"]);
  });

  it("cada membro vê as próprias permissões; o dono tem todas; quem é de fora leva 404", async () => {
    const { ana, beto, carla, base } = await withRoles();
    const dono = (await ana.agent.get(`${base}/roles`)).body.me;
    expect(dono.isOwner).toBe(true);
    expect(dono.permissions).toHaveLength(6);
    const membro = (await beto.agent.get(`${base}/roles`)).body.me;
    expect(membro).toMatchObject({ isOwner: false, permissions: [] });
    expect((await carla.agent.get(`${base}/roles`)).status).toBe(404);
  });

  it("a lista de membros mostra o cargo de cada um (o dono não tem cargo)", async () => {
    const { ana, base } = await withRoles();
    const members = (await ana.agent.get(`${base}/members`)).body.members;
    expect(members.find((m: any) => m.username === "ana")).toMatchObject({ isOwner: true, roleId: null, roleName: null });
    expect(members.find((m: any) => m.username === "beto")).toMatchObject({ roleName: "Membro" });
  });
});

describe("o dono cria, edita e apaga cargos", () => {
  it("cria um cargo com permissões e valida os dados", async () => {
    const { ana, beto, base } = await withRoles();
    const ok = await ana.agent.post(`${base}/roles`).send({ name: "  DJ ", permissions: ["manage_channels", "invite", "invite"] });
    expect(ok.status).toBe(201);
    expect(ok.body.role).toMatchObject({ name: "DJ", permissions: ["invite", "manage_channels"], isDefault: false, members: 0 });

    for (const body of [{ name: "" }, { name: "x".repeat(31) }, { name: 5 }, { name: "Ok", permissions: ["voar"] }, { name: "Ok", permissions: "invite" }]) {
      expect((await ana.agent.post(`${base}/roles`).send(body)).status).toBe(400);
    }
    expect((await ana.agent.post(`${base}/roles`).send({ name: "DJ" })).status).toBe(409);
    expect((await beto.agent.post(`${base}/roles`).send({ name: "Golpe" })).status).toBe(403);
  });

  it("edita nome e permissões, e troca o cargo padrão", async () => {
    const { ana, beto, base, byName } = await withRoles();
    const conv = byName("Convidador");
    const r = await ana.agent.patch(`${base}/roles/${conv.id}`).send({ name: "Amigo-convida", permissions: ["invite", "view_log"] });
    expect(r.body.role).toMatchObject({ name: "Amigo-convida", permissions: ["invite", "view_log"] });

    const novoPadrao = await ana.agent.patch(`${base}/roles/${conv.id}`).send({ isDefault: true });
    expect(novoPadrao.body.role.isDefault).toBe(true);
    const lista = (await ana.agent.get(`${base}/roles`)).body.roles;
    expect(lista.filter((x: any) => x.isDefault)).toHaveLength(1);
    expect(lista.find((x: any) => x.isDefault).id).toBe(conv.id);

    expect((await ana.agent.patch(`${base}/roles/${conv.id}`).send({ isDefault: false })).status).toBe(400);
    expect((await ana.agent.patch(`${base}/roles/9999`).send({ name: "x" })).status).toBe(404);
    expect((await ana.agent.patch(`${base}/roles/${byName("Membro").id}`).send({ name: "Amigo-convida" })).status).toBe(409);
    expect((await beto.agent.patch(`${base}/roles/${conv.id}`).send({ name: "x" })).status).toBe(403);
  });

  it("apagar um cargo passa os membros dele para o padrão; o padrão não se apaga", async () => {
    const { ana, beto, base, byName } = await withRoles();
    const mod = byName("Moderador");
    await ana.agent.put(`${base}/members/${beto.id}/role`).send({ roleId: mod.id });
    expect((await ana.agent.delete(`${base}/roles/${byName("Membro").id}`)).status).toBe(400);
    expect((await ana.agent.delete(`${base}/roles/${mod.id}`)).status).toBe(204);
    const members = (await ana.agent.get(`${base}/members`)).body.members;
    expect(members.find((m: any) => m.username === "beto").roleName).toBe("Membro");
    expect((await beto.agent.delete(`${base}/roles/${byName("Convidador").id}`)).status).toBe(403);
  });
});

describe("atribuir cargos", () => {
  it("só o dono atribui; não dá para dar cargo ao dono nem usar cargo de outro servidor", async () => {
    const { ana, beto, carla, base, byName, server } = await withRoles();
    const conv = byName("Convidador");
    expect((await ana.agent.put(`${base}/members/${beto.id}/role`).send({ roleId: conv.id })).status).toBe(200);
    expect((await beto.agent.get(`${base}/roles`)).body.me.permissions).toEqual(["invite"]);

    expect((await beto.agent.put(`${base}/members/${beto.id}/role`).send({ roleId: byName("Moderador").id })).status).toBe(403);
    expect((await ana.agent.put(`${base}/members/${ana.id}/role`).send({ roleId: conv.id })).status).toBe(400);
    expect((await ana.agent.put(`${base}/members/${carla.id}/role`).send({ roleId: conv.id })).status).toBe(404);
    expect((await ana.agent.put(`${base}/members/${beto.id}/role`).send({ roleId: 9999 })).status).toBe(400);
    expect((await ana.agent.put(`${base}/members/${beto.id}/role`).send({})).status).toBe(400);

    // cargo de outro servidor não vale aqui
    const outro = (await carla.agent.post("/api/servers").send({ name: "Da Carla" })).body.server;
    const cargoDeFora = (await carla.agent.get(`/api/servers/${outro.id}/roles`)).body.roles[0].id;
    expect((await ana.agent.put(`/api/servers/${server.id}/members/${beto.id}/role`).send({ roleId: cargoDeFora })).status).toBe(400);
  });

  it("os membros são avisados em tempo real quando cargos mudam", async () => {
    const { ana, beto, port, base, byName, server } = await withRoles();
    const ws = await connect(port, { Cookie: beto.cookie });
    await ana.agent.put(`${base}/members/${beto.id}/role`).send({ roleId: byName("Convidador").id });
    expect(await ws.next()).toEqual({ type: "roles.changed", serverId: server.id });
    await ana.agent.post(`${base}/roles`).send({ name: "Novo" });
    expect(await ws.next()).toEqual({ type: "roles.changed", serverId: server.id });
  });
});

describe("as permissões valem de verdade", () => {
  it("manage_channels: só quem tem (ou o dono) cria canais", async () => {
    const { ana, beto, base, byName } = await withRoles();
    expect((await beto.agent.post(`${base}/channels`).send({ name: "novo" })).status).toBe(403);
    await ana.agent.put(`${base}/members/${beto.id}/role`).send({ roleId: byName("Moderador").id });
    expect((await beto.agent.post(`${base}/channels`).send({ name: "novo" })).status).toBe(201);
  });

  it("manage_messages: moderador apaga mensagem de outro; membro comum não", async () => {
    const { ana, beto, base, byName, channelId } = await withRoles();
    const url = `/api/channels/${channelId}/messages`;
    const daAna = (await ana.agent.post(url).send({ content: "da Ana" })).body.message;
    expect((await beto.agent.delete(`${url}/${daAna.id}`)).status).toBe(403);
    await ana.agent.put(`${base}/members/${beto.id}/role`).send({ roleId: byName("Moderador").id });
    expect((await beto.agent.delete(`${url}/${daAna.id}`)).status).toBe(204);
  });

  it("quem entra por convite ganha o cargo padrão, e o cargo padrão mudado vale para os próximos", async () => {
    const { ana, carla, base, byName, code } = await withRoles();
    await ana.agent.patch(`${base}/roles/${byName("Convidador").id}`).send({ isDefault: true });
    await carla.agent.post(`/api/invites/${code}/join`);
    const members = (await ana.agent.get(`${base}/members`)).body.members;
    expect(members.find((m: any) => m.username === "carla").roleName).toBe("Convidador");
  });
});
