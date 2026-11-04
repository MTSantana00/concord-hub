import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, pause, scenario } from "./testkit.js";

afterEach(closeAll);

/** Ana (dona) cria uma sala de voz; Beto é membro, Carla é de fora. */
async function withVoice() {
  const s = await scenario();
  const res = await s.ana.agent.post(`/api/servers/${s.server.id}/channels`).send({ name: "Sala 1", type: "voice" });
  const voiceId = res.body.channel.id as number;
  return { ...s, voiceId, createRes: res };
}

const join = (c: { ws: { send(d: string): void } }, channelId: unknown) =>
  c.ws.send(JSON.stringify({ type: "voice.join", channelId }));

describe("canais de voz", () => {
  it("o dono cria canal de voz; ele vem com type e não aceita mensagem de texto", async () => {
    const { ana, beto, server, voiceId, createRes } = await withVoice();
    expect(createRes.status).toBe(201);
    expect(createRes.body.channel).toMatchObject({ id: voiceId, name: "sala-1", type: "voice", categoryId: null, readOnly: false, private: false });

    const list = (await beto.agent.get("/api/servers")).body.servers[0].channels;
    expect(list.map((c: any) => [c.name, c.type])).toEqual([["geral", "text"], ["sala-1", "voice"]]);
    expect((await beto.agent.get(`/api/servers/${server.id}/channels`)).body.channels[1].type).toBe("voice");

    expect((await ana.agent.get(`/api/channels/${voiceId}/messages`)).status).toBe(404);
    expect((await ana.agent.post(`/api/channels/${voiceId}/messages`).send({ content: "oi" })).status).toBe(404);
  });

  it("tipo inválido é recusado; sem tipo é de texto; só o dono cria", async () => {
    const { ana, beto, server } = await withVoice();
    const url = `/api/servers/${server.id}/channels`;
    expect((await ana.agent.post(url).send({ name: "x", type: "video" })).status).toBe(400);
    expect((await ana.agent.post(url).send({ name: "x", type: 5 })).status).toBe(400);
    expect((await ana.agent.post(url).send({ name: "papo" })).body.channel.type).toBe("text");
    expect((await beto.agent.post(url).send({ name: "y", type: "voice" })).status).toBe(403);
  });

  it("entrar e sair avisa todos os membros em tempo real", async () => {
    const { ana, beto, port, server, voiceId } = await withVoice();
    const wa = await connect(port, { Cookie: ana.cookie });
    const wb = await connect(port, { Cookie: beto.cookie });

    join(wb, voiceId);
    const expected = { type: "voice.joined", serverId: server.id, channelId: voiceId, user: { id: beto.id, username: "beto" } };
    expect(await wa.next()).toEqual(expected);
    expect(await wb.next()).toEqual(expected); // quem entrou também recebe

    expect((await ana.agent.get(`/api/servers/${server.id}/voice`)).body.participants).toEqual([
      { channelId: voiceId, userId: beto.id, username: "beto" },
    ]);

    wb.ws.send(JSON.stringify({ type: "voice.leave" }));
    expect(await wa.next()).toEqual({ type: "voice.left", serverId: server.id, channelId: voiceId, userId: beto.id });
    expect((await ana.agent.get(`/api/servers/${server.id}/voice`)).body.participants).toEqual([]);
  });

  it("fechar a conexão tira a pessoa da sala; outra aba aberta não segura a vaga", async () => {
    const { ana, beto, port, server, voiceId } = await withVoice();
    const wa = await connect(port, { Cookie: ana.cookie });
    const aba1 = await connect(port, { Cookie: beto.cookie });
    const aba2 = await connect(port, { Cookie: beto.cookie });

    join(aba1, voiceId);
    await wa.next();
    await aba1.close();
    expect((await wa.next()).type).toBe("voice.left");
    expect((await ana.agent.get(`/api/servers/${server.id}/voice`)).body.participants).toEqual([]);

    // fechar a aba que NÃO entrou não tira ninguém
    join(aba2, voiceId);
    await wa.next();
    const aba3 = await connect(port, { Cookie: beto.cookie });
    await aba3.close();
    await pause(100);
    expect((await ana.agent.get(`/api/servers/${server.id}/voice`)).body.participants).toHaveLength(1);
  });

  it("trocar de aparelho na mesma sala: o aparelho antigo é avisado (voice.moved) e ninguém mais", async () => {
    const { ana, beto, port, voiceId } = await withVoice();
    const wa = await connect(port, { Cookie: ana.cookie });
    const pc = await connect(port, { Cookie: beto.cookie });
    const celular = await connect(port, { Cookie: beto.cookie });

    join(pc, voiceId);
    await wa.next(); // voice.joined
    await pc.next(); // voice.joined (o próprio)
    join(celular, voiceId);
    expect(await pc.next()).toEqual({ type: "voice.moved", channelId: voiceId });
    await pause(100);
    expect(wa.received.length).toBe(0); // a sala não viu nada de novo
  });

  it("uma sala por vez: entrar em outra sai da anterior; entrar de novo na mesma não repete aviso", async () => {
    const { ana, beto, port, server, voiceId } = await withVoice();
    const outra = (await ana.agent.post(`/api/servers/${server.id}/channels`).send({ name: "sala-2", type: "voice" })).body.channel.id;
    const wa = await connect(port, { Cookie: ana.cookie });
    const wb = await connect(port, { Cookie: beto.cookie });

    join(wb, voiceId);
    expect((await wa.next()).channelId).toBe(voiceId);
    join(wb, voiceId); // de novo na mesma
    join(wb, outra);
    expect(await wa.next()).toEqual({ type: "voice.left", serverId: server.id, channelId: voiceId, userId: beto.id });
    expect((await wa.next()).channelId).toBe(outra);
    expect((await ana.agent.get(`/api/servers/${server.id}/voice`)).body.participants).toEqual([
      { channelId: outra, userId: beto.id, username: "beto" },
    ]);
  });

  it("quem não é membro, canal de texto, canal inexistente ou id inválido: recusado, sem mudar nada", async () => {
    const { ana, carla, port, server, voiceId, channelId } = await withVoice();
    const wa = await connect(port, { Cookie: ana.cookie });
    const wc = await connect(port, { Cookie: carla.cookie });

    for (const id of [voiceId, channelId, 9999, "abc", null, 1.5]) {
      join(wc, id);
      expect(await wc.next()).toMatchObject({ type: "error" });
    }
    join(wa, channelId); // até o dono: canal de texto não é sala
    expect(await wa.next()).toMatchObject({ type: "error" });
    await pause(100);
    expect(wa.received).toEqual([]);
    expect((await ana.agent.get(`/api/servers/${server.id}/voice`)).body.participants).toEqual([]);
  });

  it("a lista de participantes só vale para membros (404 para os outros, 401 sem login)", async () => {
    const { app, carla, server } = await withVoice();
    expect((await carla.agent.get(`/api/servers/${server.id}/voice`)).status).toBe(404);
    const request = (await import("supertest")).default;
    expect((await request(app).get(`/api/servers/${server.id}/voice`)).status).toBe(401);
  });

  it("mensagens do cliente mal formadas viram erro e a conexão continua; grandes demais derrubam só aquela conexão", async () => {
    const { ana, beto, port, voiceId } = await withVoice();
    const wb = await connect(port, { Cookie: beto.cookie });

    for (const lixo of ["não é json", "[]", "null", "123", '{"type":"hackear"}', "{}"]) {
      wb.ws.send(lixo);
      expect(await wb.next()).toMatchObject({ type: "error" });
    }
    wb.ws.send(Buffer.from([1, 2, 3]));
    expect(await wb.next()).toMatchObject({ type: "error" });

    // ainda funciona depois do lixo
    join(wb, voiceId);
    expect((await wb.next()).type).toBe("voice.joined");

    const closed = new Promise<number>((resolve) => wb.ws.once("close", (code) => resolve(code)));
    wb.ws.send("x".repeat(10_000));
    expect(await closed).toBe(1009);

    // o servidor segue de pé para os outros
    const wa = await connect(port, { Cookie: ana.cookie });
    join(wa, voiceId);
    expect((await wa.next()).type).toBe("voice.joined");
  });
});

describe("tirar alguém da sala de voz", () => {
  it("quem modera tira a pessoa: ela é avisada, a sala atualiza, o log registra e a chave de mídia deixa de ser dada", async () => {
    const { ana, beto, port, voiceId, server } = await withVoice();
    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    join(wsAna, voiceId);
    join(wsBeto, voiceId);
    await wsBeto.next(); // voice.joined (ana)
    await wsBeto.next(); // voice.joined (beto)
    wsAna.received.length = 0;

    expect((await ana.agent.post("/api/voice/kick").send({ userId: beto.id })).status).toBe(204);
    const eventos = [await wsBeto.next(), await wsBeto.next()];
    expect(eventos).toContainEqual({ type: "voice.kicked", serverId: server.id, channelId: voiceId, byUserId: ana.id });
    expect(eventos).toContainEqual({ type: "voice.left", serverId: server.id, channelId: voiceId, userId: beto.id });
    expect((await ana.agent.get(`/api/servers/${server.id}/voice`)).body.participants.map((p: any) => p.userId)).toEqual([ana.id]);
    expect((await beto.agent.post("/api/voice/token").send({ channelId: voiceId })).status).toBe(403);
    const log = (await ana.agent.get(`/api/servers/${server.id}/log`)).body;
    expect(JSON.stringify(log)).toContain("tirou da sala de voz");
    join(wsBeto, voiceId); // não é banimento: pode voltar
    expect((await wsBeto.next()).type).toBe("voice.joined");
  });

  it("só com permissão; não tira o dono, a si mesmo, quem não está na sala, nem sem login", async () => {
    const { app, ana, beto, carla, port, voiceId } = await withVoice();
    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    join(wsAna, voiceId);
    join(wsBeto, voiceId);
    await wsBeto.next();
    await wsBeto.next();
    expect((await beto.agent.post("/api/voice/kick").send({ userId: ana.id })).status).toBe(403); // membro comum
    expect((await ana.agent.post("/api/voice/kick").send({ userId: ana.id })).status).toBe(404); // a si mesma
    expect((await ana.agent.post("/api/voice/kick").send({ userId: carla.id })).status).toBe(404); // fora da sala
    expect((await ana.agent.post("/api/voice/kick").send({ userId: "x" })).status).toBe(404);
    expect((await carla.agent.post("/api/voice/kick").send({ userId: beto.id })).status).toBe(403); // de fora
    expect((await request(app).post("/api/voice/kick").send({ userId: beto.id })).status).toBe(401);
    expect((await ana.agent.get(`/api/servers/${(await ana.agent.get("/api/servers")).body.servers[0].id}/voice`)).body.participants).toHaveLength(2);
  });

  it("um cargo com 'expulsar e banir' pode tirar membros, mas não o dono", async () => {
    const { ana, beto, carla, port, voiceId, server, code } = await withVoice();
    await carla.agent.post(`/api/invites/${code}/join`);
    const roles = (await ana.agent.get(`/api/servers/${server.id}/roles`)).body.roles as { id: number; name: string }[];
    const moderador = roles.find((r) => r.name === "Moderador")!;
    await ana.agent.put(`/api/servers/${server.id}/members/${beto.id}/role`).send({ roleId: moderador.id });
    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    const wsCarla = await connect(port, { Cookie: carla.cookie });
    for (const ws of [wsAna, wsBeto, wsCarla]) join(ws, voiceId);
    await pause(150);
    expect((await beto.agent.post("/api/voice/kick").send({ userId: ana.id })).status).toBe(403); // o dono não sai
    expect((await beto.agent.post("/api/voice/kick").send({ userId: carla.id })).status).toBe(204);
  });
});
