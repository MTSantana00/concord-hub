import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, pause, rejectedStatus, scenario } from "./testkit.js";

afterEach(closeAll);

describe("mensagens (REST)", () => {
  it("envia e lista o histórico em ordem, com o autor", async () => {
    const { ana, beto, channelId } = await scenario();
    await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "oi gente" });
    await beto.agent.post(`/api/channels/${channelId}/messages`).send({ content: "e aí!" });

    const res = await beto.agent.get(`/api/channels/${channelId}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: any) => [m.author.username, m.content])).toEqual([
      ["ana", "oi gente"],
      ["beto", "e aí!"],
    ]);
    expect(res.body.messages[0].createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  it("devolve só as 50 mais recentes, em ordem", async () => {
    const { ana, channelId } = await scenario();
    for (let i = 1; i <= 55; i++) {
      await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: `m${i}` });
    }
    const { body } = await ana.agent.get(`/api/channels/${channelId}/messages`);
    expect(body.messages).toHaveLength(50);
    expect(body.messages[0].content).toBe("m6");
    expect(body.messages[49].content).toBe("m55");
  });

  it("recusa mensagem vazia, só com espaços, grande demais ou de tipo errado", async () => {
    const { ana, channelId } = await scenario();
    const url = `/api/channels/${channelId}/messages`;
    const results = await Promise.all(
      ["", "   ", "x".repeat(2001)].map((content) => ana.agent.post(url).send({ content })),
    );
    expect(results.map((r) => r.status)).toEqual([400, 400, 400]);
    expect((await ana.agent.post(url).send({ content: { a: 1 } })).status).toBe(400);
    expect((await ana.agent.post(url).send({ content: "x".repeat(2000) })).status).toBe(201);
  });

  it("guarda o texto como veio (sem interpretar HTML)", async () => {
    const { ana, channelId } = await scenario();
    const res = await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "<b>oi</b>" });
    expect(res.body.message.content).toBe("<b>oi</b>");
  });

  it("quem não é membro não lê nem escreve (404)", async () => {
    const { carla, channelId } = await scenario();
    expect((await carla.agent.get(`/api/channels/${channelId}/messages`)).status).toBe(404);
    expect((await carla.agent.post(`/api/channels/${channelId}/messages`).send({ content: "oi" })).status).toBe(404);
  });

  it("canal inválido dá 404 e sem login dá 401", async () => {
    const { app, ana, channelId } = await scenario();
    expect((await ana.agent.get("/api/channels/abc/messages")).status).toBe(404);
    expect((await ana.agent.get("/api/channels/9999/messages")).status).toBe(404);
    expect((await request(app).get(`/api/channels/${channelId}/messages`)).status).toBe(401);
    expect((await request(app).post(`/api/channels/${channelId}/messages`).send({ content: "x" })).status).toBe(401);
  });
});

describe("tempo real (WebSocket)", () => {
  it("a mensagem de um membro chega ao outro sem recarregar", async () => {
    const { port, ana, beto, channelId, server } = await scenario();
    const wsBeto = await connect(port, { Cookie: beto.cookie });

    const sent = await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "oi, Beto" });
    const event = await wsBeto.next();

    expect(event.type).toBe("message.created");
    expect(event.message.id).toBe(sent.body.message.id);
    expect(event.message.content).toBe("oi, Beto");
    expect(event.message.author.username).toBe("ana");
    expect(event.message.channelId).toBe(channelId);
    expect(event.message.serverId).toBe(server.id);
  });

  it("o autor também recebe o evento nas suas conexões, inclusive em várias abas", async () => {
    const { port, ana, channelId } = await scenario();
    const aba1 = await connect(port, { Cookie: ana.cookie });
    const aba2 = await connect(port, { Cookie: ana.cookie });

    await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "teste" });
    expect((await aba1.next()).message.content).toBe("teste");
    expect((await aba2.next()).message.content).toBe("teste");
  });

  it("quem não é membro do servidor não recebe a mensagem", async () => {
    const { port, ana, beto, carla, channelId } = await scenario();
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    const wsCarla = await connect(port, { Cookie: carla.cookie });

    await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "segredo" });
    await wsBeto.next(); // Beto recebeu, então o envio já aconteceu
    await pause(150);
    expect(wsCarla.received).toEqual([]);
  });

  it("recusa conexão sem login, com cookie inválido ou de outra origem", async () => {
    const { port, beto } = await scenario();
    expect(await rejectedStatus(port)).toBe(401);
    expect(await rejectedStatus(port, { Cookie: "concord_session=lixo" })).toBe(401);
    expect(await rejectedStatus(port, { Cookie: beto.cookie, Origin: "http://site-de-fora.example" })).toBe(403);
  });

  it("depois que a conexão fecha, o usuário deixa de receber (e nada quebra)", async () => {
    const { port, ana, beto, channelId } = await scenario();
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    await new Promise<void>((resolve) => {
      wsBeto.ws.once("close", () => resolve());
      wsBeto.ws.close();
    });

    const res = await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "alguém aí?" });
    expect(res.status).toBe(201);
    expect(wsBeto.received).toEqual([]);
  });
});
