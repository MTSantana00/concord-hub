import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, scenario, signup } from "./testkit.js";

afterEach(closeAll);

/** Bytes que começam como um WebM de verdade (cabeçalho EBML) — o servidor confere isso. */
const webm = (size = 2000) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(size, 7)]);
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(40)]);

function send(agent: request.Agent, url: string, body: Buffer, type = "audio/webm;codecs=opus", ms = 4200) {
  return agent.post(`${url}?ms=${ms}`).set("Content-Type", type).send(body);
}

describe("áudio em canal", () => {
  it("envia, entrega em tempo real e baixa os mesmos bytes; sobrevive ao recarregar", async () => {
    const { ana, beto, port, channelId } = await scenario();
    const ws = await connect(port, { Cookie: beto.cookie });
    const bytes = webm();

    const res = await send(ana.agent, `/api/channels/${channelId}/audio`, bytes);
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({
      content: "",
      channelId,
      audio: { durationMs: 4200, mime: "audio/webm" },
      author: { username: "ana" },
    });

    const event = await ws.next();
    expect(event.type).toBe("message.created");
    expect(event.message.id).toBe(res.body.message.id);

    const file = await beto.agent.get(`/api/audio/${res.body.message.id}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("audio/webm");
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.headers["cache-control"]).toBe("private, no-cache");
    expect(Buffer.compare(file.body, bytes)).toBe(0);

    const history = (await beto.agent.get(`/api/channels/${channelId}/messages`)).body.messages;
    expect(history[0].audio).toEqual({ durationMs: 4200, mime: "audio/webm" });
  });

  it("aceita MP4 (Safari)", async () => {
    const { ana, channelId } = await scenario();
    const res = await send(ana.agent, `/api/channels/${channelId}/audio`, mp4(), "audio/mp4");
    expect(res.status).toBe(201);
    expect(res.body.message.audio.mime).toBe("audio/mp4");
  });

  it("só membros baixam e enviam: sem login 401, de fora 404", async () => {
    const { app, ana, carla, channelId } = await scenario();
    const url = `/api/channels/${channelId}/audio`;
    const id = (await send(ana.agent, url, webm())).body.message.id;

    expect((await request(app).get(`/api/audio/${id}`)).status).toBe(401);
    expect((await request(app).post(`${url}?ms=1000`).set("Content-Type", "audio/webm").send(webm())).status).toBe(401);
    expect((await carla.agent.get(`/api/audio/${id}`)).status).toBe(404);
    expect((await send(carla.agent, url, webm())).status).toBe(404);
    expect((await ana.agent.get("/api/audio/9999")).status).toBe(404);
    expect((await ana.agent.get("/api/audio/abc")).status).toBe(404);
  });

  it("recusa duração inválida, passando de 5 minutos, e tipo que não é áudio", async () => {
    const { ana, channelId } = await scenario();
    const url = `/api/channels/${channelId}/audio`;
    for (const ms of ["0", "-5", "abc", "300001", "1.5", ""]) {
      expect((await send(ana.agent, url, webm(), "audio/webm", ms as any)).status).toBe(400);
    }
    expect((await ana.agent.post(url).set("Content-Type", "audio/webm").send(webm())).status).toBe(400);
    expect((await send(ana.agent, url, webm(), "audio/webm", 300000 as any)).status).toBe(201);

    // diz que é áudio, mas o conteúdo não é
    expect((await send(ana.agent, url, Buffer.from("<script>alert(1)</script>"))).status).toBe(415);
    // conteúdo de WebM com tipo errado, ou tipo que não é áudio
    expect((await send(ana.agent, url, webm(), "text/html")).status).toBe(415);
    expect((await send(ana.agent, url, webm(), "audio/mp4")).status).toBe(415);
    expect((await send(ana.agent, url, Buffer.alloc(0))).status).toBe(415);
    expect((await ana.agent.post(`${url}?ms=1000`).send({ content: "oi" })).status).toBe(415);
  });

  it("recusa arquivo maior que 5 MB (413)", async () => {
    const { ana, channelId } = await scenario();
    const res = await send(ana.agent, `/api/channels/${channelId}/audio`, webm(5 * 1024 * 1024 + 10));
    expect(res.status).toBe(413);
    expect((await ana.agent.get(`/api/channels/${channelId}/messages`)).body.messages).toHaveLength(0);
  });

  it("não deixa editar áudio como texto; apagar remove a mensagem e o arquivo", async () => {
    const { ana, beto, port, channelId } = await scenario();
    const url = `/api/channels/${channelId}/audio`;
    const id = (await send(beto.agent, url, webm())).body.message.id;

    const edit = await beto.agent.patch(`/api/channels/${channelId}/messages/${id}`).send({ content: "texto" });
    expect(edit.status).toBe(400);

    const ws = await connect(port, { Cookie: beto.cookie });
    // o dono do servidor modera: apaga o áudio do Beto
    expect((await ana.agent.delete(`/api/channels/${channelId}/messages/${id}`)).status).toBe(204);
    expect((await ws.next()).type).toBe("message.deleted");
    await new Promise((r) => setTimeout(r, 50));
    expect((await beto.agent.get(`/api/audio/${id}`)).status).toBe(404);
  });
});

describe("áudio em conversa direta", () => {
  it("só os dois participantes ouvem; terceiro leva 404", async () => {
    const { ana, beto, carla, port } = await scenario();
    const dm = (await ana.agent.post("/api/dms").send({ userId: beto.id })).body.dm;
    const ws = await connect(port, { Cookie: beto.cookie });

    const res = await send(ana.agent, `/api/dms/${dm.id}/audio`, webm());
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({ dmId: dm.id, channelId: null, audio: { durationMs: 4200 } });
    expect((await ws.next()).message.id).toBe(res.body.message.id);

    expect((await beto.agent.get(`/api/audio/${res.body.message.id}`)).status).toBe(200);
    expect((await carla.agent.get(`/api/audio/${res.body.message.id}`)).status).toBe(404);
    expect((await send(carla.agent, `/api/dms/${dm.id}/audio`, webm())).status).toBe(404);
  });

  it("só o autor apaga o próprio áudio", async () => {
    const { ana, beto } = await scenario();
    const dm = (await ana.agent.post("/api/dms").send({ userId: beto.id })).body.dm;
    const id = (await send(ana.agent, `/api/dms/${dm.id}/audio`, webm())).body.message.id;

    expect((await beto.agent.delete(`/api/dms/${dm.id}/messages/${id}`)).status).toBe(403);
    expect((await ana.agent.patch(`/api/dms/${dm.id}/messages/${id}`).send({ content: "x" })).status).toBe(400);
    expect((await ana.agent.delete(`/api/dms/${dm.id}/messages/${id}`)).status).toBe(204);
    expect((await ana.agent.get(`/api/audio/${id}`)).status).toBe(404);
  });
});

it("um usuário sem servidor em comum não alcança o áudio de outro (id de outro canal)", async () => {
  const { app, ana, channelId } = await scenario();
  const id = (await send(ana.agent, `/api/channels/${channelId}/audio`, webm())).body.message.id;
  const dora = await signup(app, "dora");
  expect((await dora.agent.get(`/api/audio/${id}`)).status).toBe(404);
});
