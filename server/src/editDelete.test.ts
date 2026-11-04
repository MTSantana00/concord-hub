import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, pause, scenario, signup } from "./testkit.js";

afterEach(closeAll);

/** Cenário padrão (ana dona, beto membro, carla de fora) com uma mensagem de cada um no canal. */
async function withMessages() {
  const s = await scenario();
  const url = `/api/channels/${s.channelId}/messages`;
  const daAna = (await s.ana.agent.post(url).send({ content: "da Ana" })).body.message;
  const doBeto = (await s.beto.agent.post(url).send({ content: "do Beto" })).body.message;
  return { ...s, url, daAna, doBeto };
}

describe("editar mensagem de canal", () => {
  it("o autor edita; o texto muda, editedAt aparece e o histórico reflete", async () => {
    const { beto, url, doBeto } = await withMessages();
    expect(doBeto.editedAt).toBeNull();

    const res = await beto.agent.patch(`${url}/${doBeto.id}`).send({ content: "  do Beto (corrigido) " });
    expect(res.status).toBe(200);
    expect(res.body.message.content).toBe("do Beto (corrigido)");
    expect(res.body.message.editedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);

    const lista = (await beto.agent.get(url)).body.messages;
    expect(lista.find((m: any) => m.id === doBeto.id).content).toBe("do Beto (corrigido)");
  });

  it("nem o dono do servidor edita a mensagem de outra pessoa (403)", async () => {
    const { ana, url, doBeto } = await withMessages();
    expect((await ana.agent.patch(`${url}/${doBeto.id}`).send({ content: "forjado" })).status).toBe(403);
    const lista = (await ana.agent.get(url)).body.messages;
    expect(lista.find((m: any) => m.id === doBeto.id).content).toBe("do Beto");
  });

  it("valida o novo texto", async () => {
    const { beto, url, doBeto } = await withMessages();
    for (const content of ["", "   ", "x".repeat(2001), 5, null]) {
      expect((await beto.agent.patch(`${url}/${doBeto.id}`).send({ content })).status).toBe(400);
    }
  });

  it("quem não é membro, mensagem inexistente ou de outro canal: 404", async () => {
    const { ana, beto, carla, server, url, doBeto } = await withMessages();
    expect((await carla.agent.patch(`${url}/${doBeto.id}`).send({ content: "x" })).status).toBe(404);
    expect((await beto.agent.patch(`${url}/9999`).send({ content: "x" })).status).toBe(404);
    expect((await beto.agent.patch(`${url}/abc`).send({ content: "x" })).status).toBe(404);

    // a mensagem existe, mas é de OUTRO canal: não pode ser editada por este caminho
    const outro = (await ana.agent.post(`/api/servers/${server.id}/channels`).send({ name: "jogos" })).body.channel;
    const msgOutro = (await ana.agent.post(`/api/channels/${outro.id}/messages`).send({ content: "no jogos" })).body.message;
    expect((await ana.agent.patch(`${url}/${msgOutro.id}`).send({ content: "x" })).status).toBe(404);
  });

  it("exige login", async () => {
    const { app, url, doBeto } = await withMessages();
    expect((await request(app).patch(`${url}/${doBeto.id}`).send({ content: "x" })).status).toBe(401);
    expect((await request(app).delete(`${url}/${doBeto.id}`)).status).toBe(401);
  });
});

describe("apagar mensagem de canal", () => {
  it("o autor apaga a própria mensagem", async () => {
    const { beto, url, doBeto } = await withMessages();
    expect((await beto.agent.delete(`${url}/${doBeto.id}`)).status).toBe(204);
    const lista = (await beto.agent.get(url)).body.messages;
    expect(lista.map((m: any) => m.content)).toEqual(["da Ana"]);
    expect((await beto.agent.delete(`${url}/${doBeto.id}`)).status).toBe(404); // já foi
  });

  it("o dono do servidor apaga a mensagem de qualquer um", async () => {
    const { ana, url, doBeto } = await withMessages();
    expect((await ana.agent.delete(`${url}/${doBeto.id}`)).status).toBe(204);
  });

  it("um membro comum não apaga a mensagem de outro (403) e ela continua lá", async () => {
    const { beto, url, daAna } = await withMessages();
    expect((await beto.agent.delete(`${url}/${daAna.id}`)).status).toBe(403);
    expect((await beto.agent.get(url)).body.messages.map((m: any) => m.id)).toContain(daAna.id);
  });

  it("quem não é membro recebe 404", async () => {
    const { carla, url, doBeto } = await withMessages();
    expect((await carla.agent.delete(`${url}/${doBeto.id}`)).status).toBe(404);
  });
});

describe("tempo real de editar e apagar", () => {
  it("todos os membros veem a edição e a exclusão na hora; quem é de fora não", async () => {
    const { port, ana, beto, carla, url, channelId, server, doBeto } = await withMessages();
    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    const wsCarla = await connect(port, { Cookie: carla.cookie });

    await beto.agent.patch(`${url}/${doBeto.id}`).send({ content: "editada" });
    for (const ws of [wsAna, wsBeto]) {
      const e = await ws.next();
      expect(e.type).toBe("message.updated");
      expect(e.message).toMatchObject({ id: doBeto.id, content: "editada", channelId });
      expect(e.message.editedAt).not.toBeNull();
    }

    await ana.agent.delete(`${url}/${doBeto.id}`); // o dono apaga
    for (const ws of [wsAna, wsBeto]) {
      expect(await ws.next()).toEqual({
        type: "message.deleted",
        id: doBeto.id,
        channelId,
        dmId: null,
        serverId: server.id,
      });
    }
    await pause(150);
    expect(wsCarla.received).toEqual([]);
  });
});

describe("mensagens diretas: editar e apagar", () => {
  async function comConversa() {
    const s = await scenario();
    const dm = (await s.ana.agent.post("/api/dms").send({ userId: s.beto.id })).body.dm;
    const url = `/api/dms/${dm.id}/messages`;
    const daAna = (await s.ana.agent.post(url).send({ content: "oi" })).body.message;
    return { ...s, dm, url, daAna };
  }

  it("só o autor edita e apaga, e os dois lados são avisados", async () => {
    const { port, ana, beto, dm, url, daAna } = await comConversa();
    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });

    expect((await beto.agent.patch(`${url}/${daAna.id}`).send({ content: "x" })).status).toBe(403);
    expect((await beto.agent.delete(`${url}/${daAna.id}`)).status).toBe(403);

    expect((await ana.agent.patch(`${url}/${daAna.id}`).send({ content: "oi, tudo bem?" })).status).toBe(200);
    for (const ws of [wsAna, wsBeto]) {
      const e = await ws.next();
      expect(e).toMatchObject({ type: "message.updated", message: { id: daAna.id, dmId: dm.id, content: "oi, tudo bem?" } });
    }

    expect((await ana.agent.delete(`${url}/${daAna.id}`)).status).toBe(204);
    for (const ws of [wsAna, wsBeto]) {
      expect(await ws.next()).toEqual({ type: "message.deleted", id: daAna.id, channelId: null, dmId: dm.id, serverId: null });
    }
  });

  it("um terceiro não edita nem apaga (404)", async () => {
    const { app, s0 } = await (async () => {
      const c = await comConversa();
      return { app: c.app, s0: c };
    })();
    const dani = await signup(app, "dani");
    await dani.agent.post(`/api/invites/${s0.code}/join`);
    expect((await dani.agent.patch(`${s0.url}/${s0.daAna.id}`).send({ content: "x" })).status).toBe(404);
    expect((await dani.agent.delete(`${s0.url}/${s0.daAna.id}`)).status).toBe(404);
  });
});

describe("carregar mensagens anteriores", () => {
  async function comMuitas(total: number) {
    const s = await scenario();
    const url = `/api/channels/${s.channelId}/messages`;
    for (let i = 1; i <= total; i++) await s.ana.agent.post(url).send({ content: `m${i}` });
    return { ...s, url };
  }

  it("a primeira página traz as 50 mais novas e avisa que há mais antigas", async () => {
    const { ana, url } = await comMuitas(120);
    const { body } = await ana.agent.get(url);
    expect(body.messages).toHaveLength(50);
    expect(body.messages[0].content).toBe("m71");
    expect(body.messages[49].content).toBe("m120");
    expect(body.hasMore).toBe(true);
  });

  it("com before, vêm as 50 imediatamente anteriores, sem repetir nenhuma, até acabar", async () => {
    const { ana, url } = await comMuitas(120);
    const p1 = (await ana.agent.get(url)).body;
    const p2 = (await ana.agent.get(`${url}?before=${p1.messages[0].id}`)).body;
    expect(p2.messages).toHaveLength(50);
    expect(p2.messages[0].content).toBe("m21");
    expect(p2.messages[49].content).toBe("m70");
    expect(p2.hasMore).toBe(true);

    const p3 = (await ana.agent.get(`${url}?before=${p2.messages[0].id}`)).body;
    expect(p3.messages.map((m: any) => m.content)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i + 1}`));
    expect(p3.hasMore).toBe(false);

    const ids = [...p3.messages, ...p2.messages, ...p1.messages].map((m: any) => m.id);
    expect(new Set(ids).size).toBe(120);
  });

  it("exatamente 50 mensagens não promete mais antigas", async () => {
    const { ana, url } = await comMuitas(50);
    expect((await ana.agent.get(url)).body.hasMore).toBe(false);
  });

  it("before inválido dá 400; before antes da primeira devolve lista vazia", async () => {
    const { ana, url } = await comMuitas(3);
    for (const bad of ["abc", "-1", "0", "1.5", "1e3"]) {
      expect((await ana.agent.get(`${url}?before=${bad}`)).status).toBe(400);
    }
    expect((await ana.agent.get(`${url}?before=1`)).body).toEqual({ messages: [], hasMore: false });
  });

  it("funciona também nas conversas diretas e respeita a permissão", async () => {
    const { ana, beto, carla } = await scenario();
    const dm = (await ana.agent.post("/api/dms").send({ userId: beto.id })).body.dm;
    const url = `/api/dms/${dm.id}/messages`;
    for (let i = 1; i <= 60; i++) await ana.agent.post(url).send({ content: `d${i}` });

    const p1 = (await beto.agent.get(url)).body;
    expect(p1.hasMore).toBe(true);
    const p2 = (await beto.agent.get(`${url}?before=${p1.messages[0].id}`)).body;
    expect(p2.messages.map((m: any) => m.content)).toEqual(Array.from({ length: 10 }, (_, i) => `d${i + 1}`));
    expect((await carla.agent.get(`${url}?before=${p1.messages[0].id}`)).status).toBe(404);
  });
});
