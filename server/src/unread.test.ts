import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { UNREAD_CAP, mentionsUser } from "./unread.js";
import { closeAll, connect, scenario } from "./testkit.js";

afterEach(closeAll);

async function withChat() {
  const s = await scenario();
  const dm = (await s.ana.agent.post("/api/dms").send({ userId: s.beto.id })).body.dm.id as number;
  const say = async (agent: request.Agent, base: string, content: string) =>
    (await agent.post(`${base}/messages`).send({ content })).body.message;
  const canal = `/api/channels/${s.channelId}`;
  // a primeira leitura da pessoa fixa o ponto de partida (o que já existe conta como lido)
  await s.ana.agent.get("/api/unread");
  await s.beto.agent.get("/api/unread");
  return { ...s, dm, canal, conversa: `/api/dms/${dm}`, say };
}

describe("menção", () => {
  it("só palavra inteira, sem diferenciar maiúsculas, e nunca o próprio e-mail ou @@", () => {
    expect(mentionsUser("oi @ana!", "ana")).toBe(true);
    expect(mentionsUser("@ANA vem", "ana")).toBe(true);
    expect(mentionsUser("fala, @ana.", "ana")).toBe(true);
    expect(mentionsUser("oi @anabel", "ana")).toBe(false);
    expect(mentionsUser("ana@site.com", "ana")).toBe(false);
    expect(mentionsUser("oi ana", "ana")).toBe(false);
    expect(mentionsUser("oi @a.na", "a.na")).toBe(true);
    expect(mentionsUser("oi @axna", "a.na")).toBe(false); // o ponto não vira curinga
  });
});

describe("não lidas", () => {
  it("o que já existia conta como lido; depois contam só as mensagens dos outros", async () => {
    const s = await scenario();
    await s.ana.agent.post(`/api/channels/${s.channelId}/messages`).send({ content: "antiga" });
    const primeira = (await s.beto.agent.get("/api/unread")).body;
    expect(primeira.channels[s.channelId]).toEqual({ unread: 0, mentions: 0 });

    await s.ana.agent.post(`/api/channels/${s.channelId}/messages`).send({ content: "nova 1" });
    await s.ana.agent.post(`/api/channels/${s.channelId}/messages`).send({ content: "oi @beto" });
    await s.beto.agent.post(`/api/channels/${s.channelId}/messages`).send({ content: "minha" });
    const depois = (await s.beto.agent.get("/api/unread")).body;
    expect(depois.channels[s.channelId]).toEqual({ unread: 2, mentions: 1 });
    expect((await s.ana.agent.get("/api/unread")).body.channels[s.channelId]).toEqual({ unread: 0, mentions: 0 }); // as dela
  });

  it("marcar como lido zera, avisa os outros aparelhos e nunca volta atrás", async () => {
    const { ana, beto, port, canal, say, channelId } = await withChat();
    await say(ana.agent, canal, "um");
    await say(ana.agent, canal, "dois");
    const ws = await connect(port, { Cookie: beto.cookie });
    expect((await beto.agent.put(`${canal}/read`)).status).toBe(204);
    expect(await ws.next()).toEqual({ type: "read.updated", kind: "channel", id: channelId });
    expect((await beto.agent.get("/api/unread")).body.channels[channelId]).toEqual({ unread: 0, mentions: 0 });
    await say(ana.agent, canal, "três");
    expect((await beto.agent.get("/api/unread")).body.channels[channelId].unread).toBe(1);
  });

  it("conversa direta: tudo o que o outro manda é para mim; marcar lido zera", async () => {
    const { ana, beto, conversa, dm, say } = await withChat();
    await say(ana.agent, conversa, "oi");
    await say(ana.agent, conversa, "tá aí?");
    expect((await beto.agent.get("/api/unread")).body.dms[dm]).toEqual({ unread: 2, mentions: 2 });
    expect((await ana.agent.get("/api/unread")).body.dms[dm]).toEqual({ unread: 0, mentions: 0 });
    expect((await beto.agent.put(`${conversa}/read`)).status).toBe(204);
    expect((await beto.agent.get("/api/unread")).body.dms[dm].unread).toBe(0);
  });

  it("a contagem para em 99+ e menções com % ou _ no nome não confundem a busca", async () => {
    const { ana, beto, canal, say, channelId } = await withChat();
    for (let i = 0; i < UNREAD_CAP + 5; i++) await say(ana.agent, canal, `m${i}`);
    await say(ana.agent, canal, "50% @beto_ não");
    const c = (await beto.agent.get("/api/unread")).body.channels[channelId];
    expect(c.unread).toBe(UNREAD_CAP + 1); // o cliente mostra "99+"
    expect(c.mentions).toBe(0); // @beto_ não é @beto
  });

  it("só aparecem os lugares da pessoa; de fora não lê nem marca o que não é dela", async () => {
    const { carla, canal, conversa, channelId, dm } = await withChat();
    const u = (await carla.agent.get("/api/unread")).body;
    expect(u.channels[channelId]).toBeUndefined();
    expect(u.dms[dm]).toBeUndefined();
    expect((await carla.agent.put(`${canal}/read`)).status).toBe(404);
    expect((await carla.agent.put(`${conversa}/read`)).status).toBe(404);
  });

  it("exige login", async () => {
    const { app } = await withChat();
    expect((await request(app).get("/api/unread")).status).toBe(401);
    expect((await request(app).put("/api/mutes/channel/1")).status).toBe(401);
  });
});

describe("silenciar", () => {
  it("canal, servidor e conversa: ligar, listar, avisar outros aparelhos e desligar", async () => {
    const { beto, port, channelId, server, dm } = await withChat();
    const serverId = server.id as number;
    const ws = await connect(port, { Cookie: beto.cookie });
    for (const [kind, id] of [["channel", channelId], ["server", serverId], ["dm", dm]] as const) {
      expect((await beto.agent.put(`/api/mutes/${kind}/${id}`)).status).toBe(204);
      expect(await ws.next()).toEqual({ type: "mute.updated", kind, id, muted: true });
    }
    expect((await beto.agent.put(`/api/mutes/channel/${channelId}`)).status).toBe(204); // repetir não duplica
    await ws.next();
    expect((await beto.agent.get("/api/unread")).body.mutes).toEqual({ channels: [channelId], servers: [serverId], dms: [dm] });
    expect((await beto.agent.delete(`/api/mutes/server/${serverId}`)).status).toBe(204);
    expect((await beto.agent.get("/api/unread")).body.mutes.servers).toEqual([]);
  });

  it("é de cada pessoa e só vale para o que ela pode ver", async () => {
    const { ana, beto, carla, channelId, server, dm } = await withChat();
    const serverId = server.id as number;
    await beto.agent.put(`/api/mutes/channel/${channelId}`);
    expect((await ana.agent.get("/api/unread")).body.mutes.channels).toEqual([]);
    for (const url of [`/api/mutes/channel/${channelId}`, `/api/mutes/server/${serverId}`, `/api/mutes/dm/${dm}`, "/api/mutes/outro/1", "/api/mutes/channel/abc", "/api/mutes/channel/9999"]) {
      expect((await carla.agent.put(url)).status, url).toBe(404);
    }
  });
});
