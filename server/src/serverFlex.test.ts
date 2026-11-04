import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, pause, scenario } from "./testkit.js";

afterEach(closeAll);

/** Ana (dona), Beto (cargo Membro), Carla (de fora). `roles` = cargos do servidor por nome. */
async function setup() {
  const s = await scenario();
  const roles = (await s.ana.agent.get(`/api/servers/${s.server.id}/roles`)).body.roles as { id: number; name: string }[];
  const role = (name: string) => roles.find((r) => r.name === name)!.id;
  const base = `/api/servers/${s.server.id}`;
  const create = async (body: object) => (await s.ana.agent.post(`${base}/channels`).send(body)).body.channel;
  const channelsOf = async (agent: request.Agent) => (await agent.get("/api/servers")).body.servers[0].channels as any[];
  return { ...s, role, base, create, channelsOf };
}

describe("categorias", () => {
  it("criar, renomear e apagar (os canais ficam sem categoria); só com permissão; limite de 20", async () => {
    const { ana, beto, base, create, channelsOf, server } = await setup();
    const cat = (await ana.agent.post(`${base}/categories`).send({ name: "  Jogos  " })).body.category;
    expect(cat).toEqual({ id: expect.any(Number), name: "Jogos" });
    const canal = await create({ name: "minecraft", categoryId: cat.id });
    expect(canal.categoryId).toBe(cat.id);
    expect((await beto.agent.get("/api/servers")).body.servers[0].categories).toEqual([cat]);

    expect((await ana.agent.patch(`${base}/categories/${cat.id}`).send({ name: "Games" })).body.category.name).toBe("Games");
    expect((await ana.agent.delete(`${base}/categories/${cat.id}`)).status).toBe(204);
    expect((await channelsOf(ana.agent)).find((c) => c.id === canal.id).categoryId).toBeNull();
    expect((await beto.agent.get("/api/servers")).body.servers[0].categories).toEqual([]);

    expect((await beto.agent.post(`${base}/categories`).send({ name: "x" })).status).toBe(403);
    expect((await ana.agent.post(`${base}/categories`).send({ name: "" })).status).toBe(400);
    expect((await ana.agent.post(`${base}/categories`).send({ name: "x".repeat(31) })).status).toBe(400);
    expect((await ana.agent.patch(`${base}/categories/9999`).send({ name: "y" })).status).toBe(404);
    expect((await ana.agent.delete(`${base}/categories/9999`)).status).toBe(404);
    for (let i = 0; i < 20; i++) expect((await ana.agent.post(`${base}/categories`).send({ name: `c${i}` })).status).toBe(201);
    expect((await ana.agent.post(`${base}/categories`).send({ name: "demais" })).status).toBe(400);
    expect(server.id).toBeTruthy();
  });

  it("não aceita categoria de outro servidor", async () => {
    const { ana, create, base } = await setup();
    const outro = (await ana.agent.post("/api/servers").send({ name: "Outro" })).body.server;
    const cat = (await ana.agent.post(`/api/servers/${outro.id}/categories`).send({ name: "alheia" })).body.category;
    expect((await ana.agent.post(`${base}/channels`).send({ name: "x", categoryId: cat.id })).status).toBe(400);
    expect(await create({ name: "ok" })).toBeTruthy();
  });
});

describe("canal privado", () => {
  it("quem não tem acesso não vê na lista, nem lê, nem escreve, nem recebe eventos; o dono vê tudo", async () => {
    const { ana, beto, port, base, create, channelsOf, server } = await setup();
    const secreto = await create({ name: "diretoria", private: true });
    expect(secreto).toMatchObject({ private: true, roleIds: [] });
    expect((await channelsOf(ana.agent)).map((c) => c.name)).toContain("diretoria");
    expect((await channelsOf(beto.agent)).map((c) => c.name)).toEqual(["geral"]);
    expect((await beto.agent.get(`${base}/channels`)).body.channels.map((c: any) => c.name)).toEqual(["geral"]);
    const url = `/api/channels/${secreto.id}`;
    expect((await beto.agent.get(`${url}/messages`)).status).toBe(404);
    expect((await beto.agent.post(`${url}/messages`).send({ content: "oi" })).status).toBe(404);
    expect((await beto.agent.get(`${url}/search`).query({ q: "oi" })).status).toBe(404);

    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    const m = (await ana.agent.post(`${url}/messages`).send({ content: "segredo" })).body.message;
    expect((await wsAna.next()).message.id).toBe(m.id);
    await pause(150);
    expect(wsBeto.received).toEqual([]);
    expect(server.id).toBeTruthy();
  });

  it("liberar um cargo mostra o canal para quem tem ele, na hora; tirar o cargo esconde de novo", async () => {
    const { ana, beto, port, base, create, channelsOf, role } = await setup();
    const secreto = await create({ name: "vip", private: true });
    const wsBeto = await connect(port, { Cookie: beto.cookie }, { presence: true });
    const r = await ana.agent.patch(`${base}/channels/${secreto.id}`).send({ roleIds: [role("Membro")] });
    expect(r.status).toBe(200);
    expect(r.body.channel.roleIds).toEqual([role("Membro")]);
    expect((await wsBeto.next()).type).toBe("channels.changed");
    expect((await channelsOf(beto.agent)).map((c) => c.name)).toEqual(["geral", "vip"]);
    expect((await beto.agent.get(`/api/channels/${secreto.id}/messages`)).status).toBe(200);
    expect((await channelsOf(beto.agent)).find((c) => c.name === "vip").roleIds).toBeUndefined(); // lista de cargos só para quem gerencia

    await ana.agent.patch(`${base}/channels/${secreto.id}`).send({ roleIds: [] });
    expect((await channelsOf(beto.agent)).map((c) => c.name)).toEqual(["geral"]);
  });

  it("mudar o cargo da pessoa muda o que ela enxerga; quem gerencia canais enxerga todos", async () => {
    const { ana, beto, carla, code, base, create, channelsOf, role, server } = await setup();
    const vip = await create({ name: "vip", private: true, roleIds: [role("Convidador")] });
    expect((await channelsOf(beto.agent)).map((c) => c.name)).toEqual(["geral"]);
    await ana.agent.put(`${base}/members/${beto.id}/role`).send({ roleId: role("Convidador") });
    expect((await channelsOf(beto.agent)).map((c) => c.name)).toEqual(["geral", "vip"]);

    await carla.agent.post(`/api/invites/${code}/join`);
    await ana.agent.put(`${base}/members/${carla.id}/role`).send({ roleId: role("Moderador") }); // tem "gerenciar canais"
    expect((await channelsOf(carla.agent)).map((c) => c.name)).toEqual(["geral", "vip"]);
    expect((await channelsOf(carla.agent)).find((c) => c.id === vip.id).roleIds).toEqual([role("Convidador")]);
    expect(server.id).toBeTruthy();
  });

  it("não aparece nas não lidas, e canal de voz privado não recebe nem mostra ninguém sem acesso", async () => {
    const { ana, beto, port, create, base } = await setup();
    const secreto = await create({ name: "interno", private: true });
    await beto.agent.get("/api/unread");
    await ana.agent.post(`/api/channels/${secreto.id}/messages`).send({ content: "x" });
    expect(Object.keys((await beto.agent.get("/api/unread")).body.channels)).not.toContain(String(secreto.id));

    const sala = await create({ name: "reuniao", type: "voice", private: true });
    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    wsBeto.ws.send(JSON.stringify({ type: "voice.join", channelId: sala.id }));
    expect((await wsBeto.next()).type).toBe("error");
    wsAna.ws.send(JSON.stringify({ type: "voice.join", channelId: sala.id }));
    expect((await wsAna.next()).type).toBe("voice.joined");
    await pause(150);
    expect(wsBeto.received).toEqual([]);
    expect((await beto.agent.get(`${base}/voice`)).body.participants).toEqual([]);
    expect((await ana.agent.get(`${base}/voice`)).body.participants).toHaveLength(1);
  });

  it("o 'digitando' de um canal privado só chega a quem enxerga", async () => {
    const { ana, beto, port, create, role, base } = await setup();
    const secreto = await create({ name: "restrito", private: true });
    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    wsBeto.ws.send(JSON.stringify({ type: "typing", channelId: secreto.id }));
    await pause(150);
    expect(wsAna.received).toEqual([]);
    await ana.agent.patch(`${base}/channels/${secreto.id}`).send({ roleIds: [role("Membro")] });
    wsBeto.ws.send(JSON.stringify({ type: "typing", channelId: secreto.id }));
    expect((await wsAna.next()).type).toBe("typing");
  });
});

describe("canal somente leitura", () => {
  it("todos leem e reagem, mas só o dono e quem gerencia canais escrevem (texto, anexo e áudio)", async () => {
    const { ana, beto, carla, code, base, create, role } = await setup();
    const avisos = await create({ name: "avisos", readOnly: true });
    const url = `/api/channels/${avisos.id}`;
    const aviso = (await ana.agent.post(`${url}/messages`).send({ content: "reunião sexta" })).body.message;
    expect(aviso.content).toBe("reunião sexta");

    expect((await beto.agent.get(`${url}/messages`)).body.messages).toHaveLength(1);
    const barrado = await beto.agent.post(`${url}/messages`).send({ content: "posso?" });
    expect(barrado.status).toBe(403);
    expect(barrado.body.error).toMatch(/somente leitura/);
    expect((await beto.agent.post(`${url}/attachments`).query({ name: "a.txt" }).set("Content-Type", "application/octet-stream").send(Buffer.from("x"))).status).toBe(403);
    expect((await beto.agent.post(`${url}/audio?ms=500`).set("Content-Type", "audio/webm").send(Buffer.from("x"))).status).toBe(403);
    expect((await beto.agent.post(`${url}/messages/${aviso.id}/reactions`).send({ emoji: "👍" })).status).toBe(200); // reagir pode

    await carla.agent.post(`/api/invites/${code}/join`);
    await ana.agent.put(`${base}/members/${carla.id}/role`).send({ roleId: role("Moderador") });
    expect((await carla.agent.post(`${url}/messages`).send({ content: "aviso do mod" })).status).toBe(201);

    await ana.agent.patch(`${base}/channels/${avisos.id}`).send({ readOnly: false });
    expect((await beto.agent.post(`${url}/messages`).send({ content: "agora posso" })).status).toBe(201);
  });
});

describe("editar e apagar canais", () => {
  it("renomear, trocar opções, conflitos e validações; só com permissão; registra no log", async () => {
    const { ana, beto, base, create, server } = await setup();
    const c = await create({ name: "velho" });
    await create({ name: "outro" });
    const ok = await ana.agent.patch(`${base}/channels/${c.id}`).send({ name: "Novo Nome", readOnly: true, private: false });
    expect(ok.body.channel).toMatchObject({ id: c.id, name: "novo-nome", readOnly: true });
    expect((await ana.agent.patch(`${base}/channels/${c.id}`).send({ name: "outro" })).status).toBe(409);
    expect((await ana.agent.patch(`${base}/channels/${c.id}`).send({ name: "!!" })).status).toBe(400);
    expect((await ana.agent.patch(`${base}/channels/${c.id}`).send({ readOnly: "sim" })).status).toBe(400);
    expect((await ana.agent.patch(`${base}/channels/${c.id}`).send({ roleIds: [99999] })).status).toBe(400);
    expect((await ana.agent.patch(`${base}/channels/${c.id}`).send({ roleIds: "x" })).status).toBe(400);
    expect((await ana.agent.patch(`${base}/channels/${c.id}`).send({ categoryId: 9999 })).status).toBe(400);
    expect((await ana.agent.patch(`${base}/channels/9999`).send({ name: "z" })).status).toBe(404);
    expect((await beto.agent.patch(`${base}/channels/${c.id}`).send({ name: "x" })).status).toBe(403);
    expect(JSON.stringify((await ana.agent.get(`${base}/log`)).body)).toContain("alterou o canal");
    expect(server.id).toBeTruthy();
  });

  it("apagar: some com as mensagens, tira quem estava na sala de voz, avisa todos, e o último canal não sai", async () => {
    const { ana, beto, port, base, create, channelsOf, channelId } = await setup();
    const sala = await create({ name: "sala", type: "voice" });
    const texto = await create({ name: "descartavel" });
    await ana.agent.post(`/api/channels/${texto.id}/messages`).send({ content: "tchau" });
    const wsAna = await connect(port, { Cookie: ana.cookie });
    wsAna.ws.send(JSON.stringify({ type: "voice.join", channelId: sala.id }));
    await wsAna.next();

    expect((await beto.agent.delete(`${base}/channels/${texto.id}`)).status).toBe(403);
    expect((await ana.agent.delete(`${base}/channels/${sala.id}`)).status).toBe(204);
    expect((await wsAna.next()).type).toBe("voice.left");
    expect((await ana.agent.get(`${base}/voice`)).body.participants).toEqual([]);
    expect((await ana.agent.delete(`${base}/channels/${texto.id}`)).status).toBe(204);
    expect((await ana.agent.get(`/api/channels/${texto.id}/messages`)).status).toBe(404);
    expect((await channelsOf(beto.agent)).map((c) => c.name)).toEqual(["geral"]);
    expect((await ana.agent.delete(`${base}/channels/${channelId}`)).status).toBe(400); // o último
    expect((await ana.agent.delete(`${base}/channels/9999`)).status).toBe(404);
    expect(JSON.stringify((await ana.agent.get(`${base}/log`)).body)).toContain("apagou o canal");
  });

  it("de fora não vê nada; sem login 401", async () => {
    const { app, carla, base, create } = await setup();
    const c = await create({ name: "x" });
    expect((await carla.agent.patch(`${base}/channels/${c.id}`).send({ name: "y" })).status).toBe(404);
    expect((await carla.agent.delete(`${base}/channels/${c.id}`)).status).toBe(404);
    expect((await carla.agent.post(`${base}/categories`).send({ name: "y" })).status).toBe(404);
    expect((await request(app).delete(`${base}/channels/${c.id}`)).status).toBe(401);
  });
});

describe("apelido no servidor", () => {
  it("definir, aparecer na lista de membros, avisar todos e limpar; é de cada servidor", async () => {
    const { ana, beto, port, base, server } = await setup();
    const ws = await connect(port, { Cookie: ana.cookie }, { presence: true });
    const r = await beto.agent.put(`${base}/nickname`).send({ nickname: "  Betão  " });
    expect(r.body).toEqual({ nickname: "Betão" });
    expect(await ws.next()).toEqual({ type: "member.updated", serverId: server.id, userId: beto.id, nickname: "Betão" });
    const membros = (await ana.agent.get(`${base}/members`)).body.members as any[];
    expect(membros.find((m) => m.id === beto.id).nickname).toBe("Betão");
    expect(membros.find((m) => m.id === ana.id).nickname).toBeNull();

    const outro = (await beto.agent.post("/api/servers").send({ name: "Outro" })).body.server;
    expect((await beto.agent.get(`/api/servers/${outro.id}/members`)).body.members[0].nickname).toBeNull();

    expect((await beto.agent.put(`${base}/nickname`).send({ nickname: "" })).body).toEqual({ nickname: null });
    expect((await beto.agent.put(`${base}/nickname`).send({ nickname: null })).body).toEqual({ nickname: null });
    expect((await ana.agent.get(`${base}/members`)).body.members.find((m: any) => m.id === beto.id).nickname).toBeNull();
  });

  it("limite de 32 caracteres, tipo certo, sem caracteres de controle; de fora 404", async () => {
    const { beto, carla, base } = await setup();
    expect((await beto.agent.put(`${base}/nickname`).send({ nickname: "x".repeat(33) })).status).toBe(400);
    expect((await beto.agent.put(`${base}/nickname`).send({ nickname: 5 })).status).toBe(400);
    expect((await beto.agent.put(`${base}/nickname`).send({ nickname: "a\u0000b\nc" })).body.nickname).toBe("abc");
    expect((await carla.agent.put(`${base}/nickname`).send({ nickname: "oi" })).status).toBe(404);
  });
});

describe("migração para a versão 9", () => {
  it("canais antigos continuam públicos, de texto, sem categoria e com escrita liberada", async () => {
    const { channelsOf, ana } = await setup();
    expect((await channelsOf(ana.agent))[0]).toMatchObject({ name: "geral", categoryId: null, readOnly: false, private: false });
  });
});

describe("moderar apelido de outros", () => {
  it("quem pode expulsar define e limpa o apelido de um membro; todos são avisados e o log registra", async () => {
    const { ana, beto, carla, code, port, base, role, server } = await setup();
    await carla.agent.post(`/api/invites/${code}/join`);
    await ana.agent.put(`${base}/members/${carla.id}/role`).send({ roleId: role("Moderador") });
    const ws = await connect(port, { Cookie: beto.cookie }, { presence: true });
    const r = await carla.agent.put(`${base}/members/${beto.id}/nickname`).send({ nickname: "  Beto Sério " });
    expect(r.body).toEqual({ nickname: "Beto Sério" });
    expect(await ws.next()).toEqual({ type: "member.updated", serverId: server.id, userId: beto.id, nickname: "Beto Sério" });
    expect((await ana.agent.get(`${base}/members`)).body.members.find((m: any) => m.id === beto.id).nickname).toBe("Beto Sério");
    expect((await carla.agent.put(`${base}/members/${beto.id}/nickname`).send({ nickname: "" })).body).toEqual({ nickname: null });
    expect(JSON.stringify((await ana.agent.get(`${base}/log`)).body)).toContain("mudou o apelido de");
    expect(server.id).toBeTruthy();
  });

  it("não vale para quem não modera, para o dono, para si mesmo, nem para outro moderador (só o dono)", async () => {
    const { ana, beto, carla, code, base, role } = await setup();
    await carla.agent.post(`/api/invites/${code}/join`);
    await ana.agent.put(`${base}/members/${carla.id}/role`).send({ roleId: role("Moderador") });
    expect((await beto.agent.put(`${base}/members/${carla.id}/nickname`).send({ nickname: "x" })).status).toBe(403); // membro comum
    expect((await carla.agent.put(`${base}/members/${ana.id}/nickname`).send({ nickname: "x" })).status).toBe(403); // o dono
    expect((await carla.agent.put(`${base}/members/${carla.id}/nickname`).send({ nickname: "x" })).status).toBe(400); // por aqui, não em si mesma
    await ana.agent.put(`${base}/members/${beto.id}/role`).send({ roleId: role("Moderador") });
    expect((await carla.agent.put(`${base}/members/${beto.id}/nickname`).send({ nickname: "x" })).status).toBe(403); // outro moderador
    expect((await ana.agent.put(`${base}/members/${beto.id}/nickname`).send({ nickname: "ok" })).status).toBe(200); // o dono pode
    expect((await ana.agent.put(`${base}/members/9999/nickname`).send({ nickname: "x" })).status).toBe(404);
    expect((await ana.agent.put(`${base}/members/${beto.id}/nickname`).send({ nickname: "x".repeat(33) })).status).toBe(400);
    expect((await ana.agent.put(`${base}/members/${beto.id}/nickname`).send({ nickname: 5 })).status).toBe(400);
  });
});

describe("reordenar categorias e canais", () => {
  it("define a ordem das categorias e dos canais, move canal entre categorias e avisa todos; canais novos vão para o fim", async () => {
    const { ana, beto, port, base, create, channelsOf, channelId, server } = await setup();
    const cA = (await ana.agent.post(`${base}/categories`).send({ name: "A" })).body.category.id as number;
    const cB = (await ana.agent.post(`${base}/categories`).send({ name: "B" })).body.category.id as number;
    const x = (await create({ name: "x", categoryId: cA })).id as number;
    const y = (await create({ name: "y", categoryId: cA })).id as number;
    const z = (await create({ name: "z", categoryId: cB })).id as number;
    const names = async (agent: request.Agent) => (await channelsOf(agent)).map((c) => `${c.name}@${c.categoryId}`);
    expect(await names(beto.agent)).toEqual([`geral@null`, `x@${cA}`, `y@${cA}`, `z@${cB}`]);

    const ws = await connect(port, { Cookie: beto.cookie }, { presence: true });
    const r = await ana.agent.put(`${base}/order`).send({
      categories: [cB, cA],
      channels: [
        { id: z, categoryId: cB },
        { id: y, categoryId: cB }, // y muda de categoria
        { id: x, categoryId: cA },
        { id: channelId, categoryId: null },
      ],
    });
    expect(r.status).toBe(200);
    expect((await ws.next()).type).toBe("channels.changed");
    const visto = (await beto.agent.get("/api/servers")).body.servers[0];
    expect(visto.categories.map((c: any) => c.name)).toEqual(["B", "A"]);
    expect(visto.channels.map((c: any) => `${c.name}@${c.categoryId}`)).toEqual([`z@${cB}`, `y@${cB}`, `x@${cA}`, "geral@null"]);
    expect(r.body.server.channels.map((c: any) => c.name)).toEqual(["z", "y", "x", "geral"]);

    await create({ name: "novo" });
    await ana.agent.post(`${base}/categories`).send({ name: "C" });
    const depois = (await ana.agent.get("/api/servers")).body.servers[0];
    expect(depois.channels.at(-1).name).toBe("novo");
    expect(depois.categories.at(-1).name).toBe("C");
    expect(server.id).toBeTruthy();
  });

  it("só quem gerencia canais; recusa ids de outro servidor, repetidos ou mal formados; nada muda quando recusa", async () => {
    const { ana, beto, carla, base, create, channelsOf } = await setup();
    const a = await create({ name: "a" });
    const b = await create({ name: "b" });
    const outro = (await ana.agent.post("/api/servers").send({ name: "Outro" })).body.server;
    const catAlheia = (await ana.agent.post(`/api/servers/${outro.id}/categories`).send({ name: "alheia" })).body.category.id;
    const antes = (await channelsOf(ana.agent)).map((c) => c.name);

    expect((await beto.agent.put(`${base}/order`).send({ channels: [{ id: b.id, categoryId: null }] })).status).toBe(403);
    expect((await carla.agent.put(`${base}/order`).send({ channels: [] })).status).toBe(404);
    for (const body of [
      { channels: [{ id: outro.channels[0].id, categoryId: null }] }, // canal de outro servidor
      { channels: [{ id: a.id, categoryId: catAlheia }] }, // categoria de outro servidor
      { categories: [catAlheia] },
      { channels: [{ id: a.id, categoryId: null }, { id: a.id, categoryId: null }] }, // repetido
      { channels: [{ id: "a", categoryId: null }] },
      { channels: [{ id: a.id }] },
      { channels: "x" },
      { categories: [1, 1] },
    ]) {
      expect((await ana.agent.put(`${base}/order`).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await channelsOf(ana.agent)).map((c) => c.name)).toEqual(antes);
    expect((await ana.agent.put(`${base}/order`).send({ channels: [{ id: b.id, categoryId: null }, { id: a.id, categoryId: null }] })).status).toBe(200);
    expect((await channelsOf(ana.agent)).map((c) => c.name).slice(0, 3)).toEqual(["geral", "b", "a"]); // quem não veio na lista mantém o lugar (posição 0, primeiro)
  });
});
