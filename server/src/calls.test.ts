import { TokenVerifier } from "livekit-server-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, pause, scenario } from "./testkit.js";

afterEach(closeAll);

type Conn = Awaited<ReturnType<typeof connect>>;
const send = (c: Conn, msg: object) => c.ws.send(JSON.stringify(msg));

/** Ana e Beto (membros do mesmo servidor), conectados, com a DM aberta; Carla de fora. */
async function withDm(opts: { ringMs?: number } = {}) {
  const s = await scenario(opts);
  const dm = (await s.ana.agent.post("/api/dms").send({ userId: s.beto.id })).body.dm;
  const wa = await connect(s.port, { Cookie: s.ana.cookie });
  const wb = await connect(s.port, { Cookie: s.beto.cookie });
  return { ...s, dmId: dm.id as number, wa, wb };
}

const token = (agent: any, body: object) => agent.post("/api/voice/token").send(body);

describe("chamadas na conversa direta", () => {
  it("toca nos dois lados, a outra pessoa atende e a chamada fica ativa", async () => {
    const { wa, wb, dmId, ana, beto } = await withDm();
    send(wa, { type: "call.start", dmId });
    const ringing = { type: "call.ringing", dmId, from: { id: ana.id, username: "ana" }, to: { id: beto.id, username: "beto" } };
    expect(await wb.next()).toEqual(ringing);
    expect(await wa.next()).toEqual(ringing);

    expect((await token(ana.agent, { dmId })).status).toBe(403); // ainda tocando: sem sala

    send(wb, { type: "call.accept", dmId });
    expect(await wa.next()).toEqual({ type: "call.accepted", dmId });
    expect(await wb.next()).toEqual({ type: "call.accepted", dmId });

    for (const u of [ana, beto]) {
      const res = await token(u.agent, { dmId });
      expect(res.status).toBe(200);
      const claims = await new TokenVerifier("devkey", "secret").verify(res.body.token);
      expect(claims.video).toMatchObject({ room: `call-${dmId}`, roomJoin: true });
      expect(claims.sub).toBe(String(u.id));
    }
  });

  it("recusar, cancelar e desligar terminam a chamada para os dois", async () => {
    const { wa, wb, dmId, ana } = await withDm();

    send(wa, { type: "call.start", dmId });
    await wa.next(); await wb.next();
    send(wb, { type: "call.decline", dmId });
    expect(await wa.next()).toEqual({ type: "call.ended", dmId, reason: "declined" });
    expect(await wb.next()).toEqual({ type: "call.ended", dmId, reason: "declined" });

    send(wa, { type: "call.start", dmId });
    await wa.next(); await wb.next();
    send(wa, { type: "call.hangup", dmId }); // quem chama cancela
    expect((await wb.next()).reason).toBe("cancelled");
    await wa.next();

    send(wa, { type: "call.start", dmId });
    await wa.next(); await wb.next();
    send(wb, { type: "call.accept", dmId });
    await wa.next(); await wb.next();
    send(wb, { type: "call.hangup", dmId });
    expect((await wa.next()).reason).toBe("hangup");
    await wb.next();
    expect((await token(ana.agent, { dmId })).status).toBe(403); // acabou: a chave não vale mais
  });

  it("ninguém atende: a chamada vira perdida", async () => {
    const { wa, wb, dmId } = await withDm({ ringMs: 80 });
    send(wa, { type: "call.start", dmId });
    await wa.next(); await wb.next();
    expect(await wa.next()).toEqual({ type: "call.ended", dmId, reason: "missed" });
    expect((await wb.next()).reason).toBe("missed");
  });

  it("fechar a conexão de quem está na chamada derruba a chamada", async () => {
    const { wa, wb, dmId } = await withDm();
    send(wa, { type: "call.start", dmId });
    await wa.next(); await wb.next();
    send(wb, { type: "call.accept", dmId });
    await wa.next(); await wb.next();
    await wb.close();
    expect(await wa.next()).toEqual({ type: "call.ended", dmId, reason: "disconnected" });
  });

  it("terceiros não ligam, não atendem e não recebem chave", async () => {
    const { port, wa, wb, dmId, carla } = await withDm();
    const wc = await connect(port, { Cookie: carla.cookie });

    send(wc, { type: "call.start", dmId });
    expect(await wc.next()).toMatchObject({ type: "error" });

    send(wa, { type: "call.start", dmId });
    await wa.next(); await wb.next();
    send(wc, { type: "call.accept", dmId });
    expect(await wc.next()).toMatchObject({ type: "error" });
    send(wc, { type: "call.hangup", dmId });
    expect(await wc.next()).toMatchObject({ type: "error" });
    expect((await token(carla.agent, { dmId })).status).toBe(403);

    send(wb, { type: "call.accept", dmId });
    await wa.next(); await wb.next();
    expect((await token(carla.agent, { dmId })).status).toBe(403);
    await pause(50);
    expect(wc.received).toEqual([]); // nem soube da chamada
  });

  it("quem chama não pode atender a própria chamada; quem atende não pode chamar de volta", async () => {
    const { wa, wb, dmId } = await withDm();
    send(wa, { type: "call.start", dmId });
    await wa.next(); await wb.next();
    send(wa, { type: "call.accept", dmId });
    expect(await wa.next()).toMatchObject({ type: "error" });
    send(wb, { type: "call.start", dmId });
    expect(await wb.next()).toMatchObject({ type: "error", error: "Você já está em uma chamada" });
  });

  it("ocupado: quem está em outra chamada recebe 'ocupado'; offline também é avisado", async () => {
    const { app, port, wa, wb, dmId, ana, beto, carla, server, code } = await withDm();
    // Carla entra no servidor, abre DM com a Ana e liga enquanto a Ana já está falando com o Beto
    await carla.agent.post(`/api/invites/${code}/join`);
    const dmCarla = (await carla.agent.post("/api/dms").send({ userId: ana.id })).body.dm.id;
    const wc = await connect(port, { Cookie: carla.cookie });

    send(wa, { type: "call.start", dmId });
    await wa.next(); await wb.next();
    send(wc, { type: "call.start", dmId: dmCarla });
    expect(await wc.next()).toMatchObject({ type: "error", error: "A pessoa está ocupada em outra chamada" });

    // offline: Beto sai e Carla tenta ligar para ele
    send(wa, { type: "call.hangup", dmId });
    await wa.next(); await wb.next();
    await wb.close();
    const dmCarlaBeto = (await carla.agent.post("/api/dms").send({ userId: beto.id })).body.dm.id;
    send(wc, { type: "call.start", dmId: dmCarlaBeto });
    expect(await wc.next()).toMatchObject({ type: "error", error: "A pessoa está offline" });
    void app; void server;
  });

  it("entrar numa sala de voz desliga a chamada, e atender sai da sala de voz", async () => {
    const { ana, beto, wa, wb, dmId, server } = await withDm();
    const sala = (await ana.agent.post(`/api/servers/${server.id}/channels`).send({ name: "sala", type: "voice" })).body.channel.id;

    send(wb, { type: "voice.join", channelId: sala });
    expect((await wb.next()).type).toBe("voice.joined");
    await wa.next(); // aviso para a Ana também (ela é membro)

    send(wa, { type: "call.start", dmId });
    await wa.next(); await wb.next();
    send(wb, { type: "call.accept", dmId });
    // atender tira o Beto da sala de voz
    const eventos = [await wb.next(), await wb.next()].map((e) => e.type).sort();
    expect(eventos).toEqual(["call.accepted", "voice.left"]);
    expect(beto.id).toBeGreaterThan(0);
    await wa.next();
    await wa.next();

    // e entrar numa sala de voz encerra a chamada
    send(wa, { type: "voice.join", channelId: sala });
    const evA = [await wa.next(), await wa.next()].map((e) => e.type).sort();
    expect(evA).toEqual(["call.ended", "voice.joined"]);
  });

  it("mensagens de chamada inválidas viram erro", async () => {
    const { wa } = await withDm();
    for (const m of [{ type: "call.start" }, { type: "call.start", dmId: "x" }, { type: "call.start", dmId: 9999 }, { type: "call.accept", dmId: 1 }]) {
      send(wa, m);
      expect(await wa.next()).toMatchObject({ type: "error" });
    }
  });
});
