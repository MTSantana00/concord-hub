import { TokenVerifier } from "livekit-server-sdk";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, scenario } from "./testkit.js";

afterEach(closeAll);

async function withVoice() {
  const s = await scenario();
  const voiceId = (await s.ana.agent.post(`/api/servers/${s.server.id}/channels`).send({ name: "sala", type: "voice" }))
    .body.channel.id as number;
  return { ...s, voiceId };
}

const token = (agent: request.Agent, channelId: unknown) => agent.post("/api/voice/token").send({ channelId });

describe("chave de acesso à sala de voz", () => {
  it("quem está na sala recebe uma chave que só abre aquela sala, com sua identidade", async () => {
    const { beto, port, voiceId } = await withVoice();
    const ws = await connect(port, { Cookie: beto.cookie });
    ws.ws.send(JSON.stringify({ type: "voice.join", channelId: voiceId }));
    await ws.next();

    const res = await token(beto.agent, voiceId);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("ws://localhost:7880");

    const claims = await new TokenVerifier("devkey", "secret").verify(res.body.token);
    expect(claims.sub).toBe(String(beto.id));
    expect(claims.name).toBe("beto");
    expect(claims.video).toMatchObject({ room: `voice-${voiceId}`, roomJoin: true, canPublish: true, canSubscribe: true });
    expect(claims.video?.roomAdmin).toBeFalsy();
  });

  it("sem entrar na sala (ou em outra sala, ou depois de sair): 403; sem login: 401; entrada inválida: 400", async () => {
    const { app, ana, beto, carla, port, server, voiceId } = await withVoice();
    const outra = (await ana.agent.post(`/api/servers/${server.id}/channels`).send({ name: "outra", type: "voice" })).body.channel.id;

    expect((await token(beto.agent, voiceId)).status).toBe(403);
    expect((await token(carla.agent, voiceId)).status).toBe(403);

    const ws = await connect(port, { Cookie: beto.cookie });
    ws.ws.send(JSON.stringify({ type: "voice.join", channelId: voiceId }));
    await ws.next();
    expect((await token(beto.agent, outra)).status).toBe(403); // está em outra sala
    expect((await token(beto.agent, voiceId)).status).toBe(200);

    ws.ws.send(JSON.stringify({ type: "voice.leave" }));
    await ws.next();
    expect((await token(beto.agent, voiceId)).status).toBe(403);

    expect((await request(app).post("/api/voice/token").send({ channelId: voiceId })).status).toBe(401);
    for (const channelId of ["abc", null, 1.5, undefined]) {
      expect((await token(beto.agent, channelId)).status).toBe(400);
    }
  });
});
