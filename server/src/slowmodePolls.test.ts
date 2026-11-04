import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, pause, scenario } from "./testkit.js";

afterEach(closeAll);

describe("modo lento", () => {
  it("o dono configura; membro espera entre mensagens (texto, enquete e anexo); o dono não é limitado", async () => {
    const { ana, beto, server, channelId } = await scenario();
    const url = `/api/servers/${server.id}/channels/${channelId}`;
    expect((await beto.agent.patch(url).send({ slowmodeSeconds: 2 })).status).toBe(403);
    expect((await ana.agent.patch(url).send({ slowmodeSeconds: -1 })).status).toBe(400);
    expect((await ana.agent.patch(url).send({ slowmodeSeconds: 1.5 })).status).toBe(400);
    expect((await ana.agent.patch(url).send({ slowmodeSeconds: 999999 })).status).toBe(400);
    expect((await ana.agent.patch(url).send({ slowmodeSeconds: 2 })).status).toBe(200);
    const canal = (await beto.agent.get("/api/servers")).body.servers[0].channels.find((c: any) => c.id === channelId);
    expect(canal.slowmodeSeconds).toBe(2);

    expect((await beto.agent.post(`/api/channels/${channelId}/messages`).send({ content: "um" })).status).toBe(201);
    const logo = await beto.agent.post(`/api/channels/${channelId}/messages`).send({ content: "dois" });
    expect(logo.status).toBe(429);
    expect(logo.body.retryAfter).toBeGreaterThan(0);
    expect(logo.body.error).toMatch(/Modo lento/);
    expect((await beto.agent.post(`/api/channels/${channelId}/polls`).send({ question: "q", options: ["a", "b"] })).status).toBe(429);
    const anexo = await beto.agent.post(`/api/channels/${channelId}/attachments?name=a.txt`).set("Content-Type", "text/plain").send("oi");
    expect(anexo.status).toBe(429);

    // o dono não é limitado
    expect((await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "a1" })).status).toBe(201);
    expect((await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "a2" })).status).toBe(201);

    await pause(2100);
    expect((await beto.agent.post(`/api/channels/${channelId}/messages`).send({ content: "de novo" })).status).toBe(201);

    // desligar
    expect((await ana.agent.patch(url).send({ slowmodeSeconds: 0 })).status).toBe(200);
    expect((await beto.agent.post(`/api/channels/${channelId}/messages`).send({ content: "livre 1" })).status).toBe(201);
    expect((await beto.agent.post(`/api/channels/${channelId}/messages`).send({ content: "livre 2" })).status).toBe(201);
  });
});

describe("enquetes", () => {
  const poll = { question: "Qual jogo hoje?", options: ["Minecraft", "Valorant", "  Minecraft  ", "", "CS"] };

  it("criar: valida pergunta e opções, descarta repetidas, chega para todos em tempo real", async () => {
    const { ana, beto, port, channelId } = await scenario();
    const ws = await connect(port, { Cookie: beto.cookie });
    const r = await ana.agent.post(`/api/channels/${channelId}/polls`).send(poll);
    expect(r.status).toBe(201);
    expect(r.body.message.content).toBe("Qual jogo hoje?");
    expect(r.body.message.poll.multiple).toBe(false);
    expect(r.body.message.poll.options.map((o: any) => o.text)).toEqual(["Minecraft", "Valorant", "CS"]);
    expect(r.body.message.poll.options.every((o: any) => o.users.length === 0)).toBe(true);
    const evento = await ws.next();
    expect(evento.type).toBe("message.created");
    expect(evento.message.id).toBe(r.body.message.id);

    // aparece no histórico
    const hist = (await beto.agent.get(`/api/channels/${channelId}/messages`)).body.messages;
    expect(hist.find((m: any) => m.id === r.body.message.id).poll.options).toHaveLength(3);
    // mensagem comum não tem enquete
    const comum = (await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "oi" })).body.message;
    expect(comum.poll).toBeNull();

    const url = `/api/channels/${channelId}/polls`;
    expect((await ana.agent.post(url).send({ question: "", options: ["a", "b"] })).status).toBe(400);
    expect((await ana.agent.post(url).send({ question: "x".repeat(201), options: ["a", "b"] })).status).toBe(400);
    expect((await ana.agent.post(url).send({ question: "q", options: ["só uma"] })).status).toBe(400);
    expect((await ana.agent.post(url).send({ question: "q", options: ["a", "A"] })).status).toBe(400); // repetidas
    expect((await ana.agent.post(url).send({ question: "q", options: Array.from({ length: 11 }, (_, i) => `o${i}`) })).status).toBe(400);
    expect((await ana.agent.post(url).send({ question: "q", options: ["a", "x".repeat(81)] })).status).toBe(400);
    expect((await ana.agent.post(url).send({ question: "q", options: ["a", 3] })).status).toBe(400);
    expect((await ana.agent.post(url).send({ question: "q", options: ["a", "b"], multiple: "sim" })).status).toBe(400);
    await ws.close();
  });

  it("votar: escolha única troca o voto, clicar de novo tira; várias opções acumulam; todos veem na hora", async () => {
    const { ana, beto, port, channelId } = await scenario();
    const unica = (await ana.agent.post(`/api/channels/${channelId}/polls`).send(poll)).body.message;
    const [mine, val] = unica.poll.options;
    const ws = await connect(port, { Cookie: ana.cookie });
    const vote = (agent: any, id: number, optionId: number) => agent.post(`/api/channels/${channelId}/messages/${id}/vote`).send({ optionId });

    let r = await vote(beto.agent, unica.id, mine.id);
    expect(r.status).toBe(200);
    expect(r.body.message.poll.options[0].users).toEqual([beto.id]);
    const evento = await ws.next();
    expect(evento.type).toBe("message.updated");
    expect(evento.message.poll.options[0].users).toEqual([beto.id]);

    r = await vote(beto.agent, unica.id, val.id); // troca
    expect(r.body.message.poll.options.map((o: any) => o.users.length)).toEqual([0, 1, 0]);
    await vote(ana.agent, unica.id, val.id);
    r = await vote(beto.agent, unica.id, val.id); // tira o voto
    expect(r.body.message.poll.options.map((o: any) => o.users.length)).toEqual([0, 1, 0]);
    expect(r.body.message.poll.options[1].users).toEqual([ana.id]);

    const varias = (await ana.agent.post(`/api/channels/${channelId}/polls`).send({ ...poll, multiple: true })).body.message;
    expect(varias.poll.multiple).toBe(true);
    await vote(beto.agent, varias.id, varias.poll.options[0].id);
    r = await vote(beto.agent, varias.id, varias.poll.options[2].id);
    expect(r.body.message.poll.options.map((o: any) => o.users.length)).toEqual([1, 0, 1]);

    // erros
    expect((await vote(beto.agent, unica.id, 999999)).status).toBe(400);
    expect((await vote(beto.agent, unica.id, varias.poll.options[0].id)).status).toBe(400); // opção de outra enquete
    const comum = (await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "oi" })).body.message;
    expect((await vote(beto.agent, comum.id, mine.id)).status).toBe(404);
    expect((await vote(beto.agent, 999999, mine.id)).status).toBe(404);
    await ws.close();
  });

  it("quem não é do servidor não cria nem vota; apagar a mensagem apaga opções e votos", async () => {
    const { ana, beto, carla, channelId } = await scenario();
    const m = (await ana.agent.post(`/api/channels/${channelId}/polls`).send(poll)).body.message;
    expect((await carla.agent.post(`/api/channels/${channelId}/polls`).send(poll)).status).toBe(404);
    expect((await carla.agent.post(`/api/channels/${channelId}/messages/${m.id}/vote`).send({ optionId: m.poll.options[0].id })).status).toBe(404);
    await beto.agent.post(`/api/channels/${channelId}/messages/${m.id}/vote`).send({ optionId: m.poll.options[0].id });
    expect((await ana.agent.delete(`/api/channels/${channelId}/messages/${m.id}`)).status).toBe(204);
    expect((await beto.agent.post(`/api/channels/${channelId}/messages/${m.id}/vote`).send({ optionId: m.poll.options[0].id })).status).toBe(404);
  });
});
