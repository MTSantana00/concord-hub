import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, pause, scenario, signup } from "./testkit.js";

afterEach(closeAll);

/** O cenário padrão (ana dona, beto membro, carla de fora) mais a Dani, que também está no servidor. */
async function withDani() {
  const s = await scenario();
  const dani = await signup(s.app, "dani");
  await dani.agent.post(`/api/invites/${s.code}/join`);
  return { ...s, dani };
}

const open = (who: { agent: ReturnType<typeof request.agent> }, userId: number) =>
  who.agent.post("/api/dms").send({ userId });

describe("abrir conversa", () => {
  it("cria a conversa e devolve a mesma quando qualquer um dos dois abre de novo", async () => {
    const { ana, beto } = await scenario();

    const primeira = await open(ana, beto.id);
    expect(primeira.status).toBe(201);
    expect(primeira.body.dm.user.username).toBe("beto");

    const denovo = await open(ana, beto.id);
    const doOutroLado = await open(beto, ana.id);
    expect(denovo.status).toBe(200);
    expect(denovo.body.dm.id).toBe(primeira.body.dm.id);
    expect(doOutroLado.body.dm.id).toBe(primeira.body.dm.id);
    expect(doOutroLado.body.dm.user.username).toBe("ana");
  });

  it("não deixa conversar consigo mesmo nem com dados inválidos", async () => {
    const { ana } = await scenario();
    expect((await open(ana, ana.id)).status).toBe(400);
    for (const userId of ["2", null, 1.5, { a: 1 }]) {
      expect((await ana.agent.post("/api/dms").send({ userId })).status).toBe(400);
    }
  });

  it("só dá para chamar quem divide um servidor com você; o resto 'não existe'", async () => {
    const { ana, carla } = await scenario();
    expect((await open(ana, carla.id)).status).toBe(404); // existe, mas não divide servidor
    expect((await open(ana, 9999)).status).toBe(404); // não existe
  });

  it("mostra se o outro está online", async () => {
    const { port, ana, beto } = await scenario();
    expect((await open(ana, beto.id)).body.dm.user.online).toBe(false);
    await connect(port, { Cookie: beto.cookie });
    expect((await open(ana, beto.id)).body.dm.user.online).toBe(true);
  });

  it("exige login", async () => {
    const { app } = await scenario();
    expect((await request(app).post("/api/dms").send({ userId: 1 })).status).toBe(401);
    expect((await request(app).get("/api/dms")).status).toBe(401);
  });
});

describe("mensagens diretas", () => {
  it("os dois trocam mensagens e veem o histórico em ordem", async () => {
    const { ana, beto } = await scenario();
    const { id } = (await open(ana, beto.id)).body.dm;

    await ana.agent.post(`/api/dms/${id}/messages`).send({ content: "oi, Beto" });
    await beto.agent.post(`/api/dms/${id}/messages`).send({ content: "oi, Ana" });

    for (const quem of [ana, beto]) {
      const res = await quem.agent.get(`/api/dms/${id}/messages`);
      expect(res.body.messages.map((m: any) => [m.author.username, m.content])).toEqual([
        ["ana", "oi, Beto"],
        ["beto", "oi, Ana"],
      ]);
    }
  });

  it("a mensagem não tem canal nem servidor, e as de canal não vazam para a conversa", async () => {
    const { ana, beto, channelId } = await scenario();
    const { id } = (await open(ana, beto.id)).body.dm;
    const dm = await ana.agent.post(`/api/dms/${id}/messages`).send({ content: "particular" });
    await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "público" });

    expect(dm.body.message).toMatchObject({ dmId: id, channelId: null, serverId: null });
    const doCanal = await beto.agent.get(`/api/channels/${channelId}/messages`);
    expect(doCanal.body.messages.map((m: any) => m.content)).toEqual(["público"]);
    expect(doCanal.body.messages[0].dmId).toBeNull();
    const daConversa = await beto.agent.get(`/api/dms/${id}/messages`);
    expect(daConversa.body.messages.map((m: any) => m.content)).toEqual(["particular"]);
  });

  it("valida o texto como nos canais", async () => {
    const { ana, beto } = await scenario();
    const { id } = (await open(ana, beto.id)).body.dm;
    const url = `/api/dms/${id}/messages`;
    expect((await ana.agent.post(url).send({ content: "  " })).status).toBe(400);
    expect((await ana.agent.post(url).send({ content: "x".repeat(2001) })).status).toBe(400);
    expect((await ana.agent.post(url).send({ content: 42 })).status).toBe(400);
  });

  it("um terceiro, mesmo no mesmo servidor, não lê nem escreve (404)", async () => {
    const { ana, beto, dani, carla } = await withDani();
    const { id } = (await open(ana, beto.id)).body.dm;
    await ana.agent.post(`/api/dms/${id}/messages`).send({ content: "segredo" });

    for (const intruso of [dani, carla]) {
      expect((await intruso.agent.get(`/api/dms/${id}/messages`)).status).toBe(404);
      expect((await intruso.agent.post(`/api/dms/${id}/messages`).send({ content: "oi" })).status).toBe(404);
    }
    expect((await ana.agent.get("/api/dms/abc/messages")).status).toBe(404);
    expect((await ana.agent.get("/api/dms/9999/messages")).status).toBe(404);
  });

  it("chega em tempo real aos dois lados e a mais ninguém", async () => {
    const { port, ana, beto, dani, carla } = await withDani();
    const { id } = (await open(ana, beto.id)).body.dm;
    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    const wsDani = await connect(port, { Cookie: dani.cookie });
    const wsCarla = await connect(port, { Cookie: carla.cookie });

    await ana.agent.post(`/api/dms/${id}/messages`).send({ content: "só para o Beto" });

    for (const ws of [wsAna, wsBeto]) {
      const e = await ws.next();
      expect(e.type).toBe("message.created");
      expect(e.message).toMatchObject({ dmId: id, content: "só para o Beto", channelId: null, serverId: null });
    }
    await pause(150);
    expect(wsDani.received).toEqual([]);
    expect(wsCarla.received).toEqual([]);
  });
});

describe("lista de conversas", () => {
  it("só mostra conversas com mensagem, da mais recente para a mais antiga, para os dois lados", async () => {
    const { ana, beto, dani } = await withDani();
    const comBeto = (await open(ana, beto.id)).body.dm.id;
    const comDani = (await open(ana, dani.id)).body.dm.id;

    // Abrir não basta: ainda sem mensagens, ninguém vê conversa nenhuma
    expect((await ana.agent.get("/api/dms")).body.dms).toEqual([]);
    expect((await beto.agent.get("/api/dms")).body.dms).toEqual([]);

    await ana.agent.post(`/api/dms/${comBeto}/messages`).send({ content: "1" });
    await ana.agent.post(`/api/dms/${comDani}/messages`).send({ content: "2" });
    const lista = (await ana.agent.get("/api/dms")).body.dms;
    expect(lista.map((d: any) => d.user.username)).toEqual(["dani", "beto"]);

    await beto.agent.post(`/api/dms/${comBeto}/messages`).send({ content: "3" }); // Beto responde
    expect((await ana.agent.get("/api/dms")).body.dms.map((d: any) => d.user.username)).toEqual(["beto", "dani"]);

    // O Beto vê a conversa com a Ana; a Dani vê a dela; um não vê a do outro
    expect((await beto.agent.get("/api/dms")).body.dms.map((d: any) => d.user.username)).toEqual(["ana"]);
    expect((await dani.agent.get("/api/dms")).body.dms.map((d: any) => d.user.username)).toEqual(["ana"]);
  });
});
