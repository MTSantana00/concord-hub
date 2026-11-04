import { TokenVerifier } from "livekit-server-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { MediaPool, type MediaConfig } from "./mediaPool.js";
import { meterOf } from "./app.js";
import { closeAll, connect, scenario } from "./testkit.js";

afterEach(closeAll);

const primary: MediaConfig = { url: "wss://principal.teste", apiKey: "kp", apiSecret: "segredo-principal" };
const fallback: MediaConfig = { url: "wss://reserva.teste", apiKey: "kf", apiSecret: "segredo-reserva" };

/** Cenário com as duas pontas de mídia, um "ping" que a gente controla e um RoomService falso que anota o que recebe. */
async function withMedia() {
  const state = { up: true };
  const pool = new MediaPool({ primary, fallback }, async () => state.up);
  const removed: Array<{ cfg: MediaConfig; room: string; identity: string }> = [];
  const s = await scenario({
    mediaPool: pool,
    makeRoomService: (cfg: MediaConfig) => ({
      removeParticipant: async (room: string, identity: string) => {
        removed.push({ cfg, room, identity });
      },
    }),
  });
  const voiceId = (await s.ana.agent.post(`/api/servers/${s.server.id}/channels`).send({ name: "sala", type: "voice" })).body.channel.id as number;
  const outraId = (await s.ana.agent.post(`/api/servers/${s.server.id}/channels`).send({ name: "outra", type: "voice" })).body.channel.id as number;
  const derrubar = async () => {
    state.up = false;
    await pool.check();
    await pool.check();
  };
  return { ...s, pool, state, removed, voiceId, outraId, derrubar };
}

async function sentar(port: number, user: { cookie: string }, channelId: number) {
  const c = await connect(port, { Cookie: user.cookie });
  c.ws.send(JSON.stringify({ type: "voice.join", channelId }));
  await c.next();
  return c;
}

const token = (user: { agent: any }, body: object) => user.agent.post("/api/voice/token").send(body);

describe("servidor de mídia escolhido pelo pool", () => {
  it("token: devolve o url do servidor escolhido, assinado com a chave dele, e nunca traz o segredo", async () => {
    const { ana, port, voiceId } = await withMedia();
    await sentar(port, ana, voiceId);
    const res = await token(ana, { channelId: voiceId });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("wss://principal.teste");
    const claims = await new TokenVerifier("kp", "segredo-principal").verify(res.body.token);
    expect(claims.video).toMatchObject({ room: `voice-${voiceId}`, roomJoin: true });
    const texto = JSON.stringify(res.body);
    expect(texto).not.toContain("segredo-principal");
    expect(texto).not.toContain("segredo-reserva");
  });

  it("sala fixa na prática: a principal cai com Ana na sala; Beto entra na mesma sala e recebe a principal; sala nova nasce na reserva", async () => {
    const { ana, beto, port, voiceId, outraId, derrubar } = await withMedia();
    await sentar(port, ana, voiceId);
    expect((await token(ana, { channelId: voiceId })).body.url).toBe("wss://principal.teste");

    await derrubar();

    await sentar(port, beto, voiceId);
    const doBeto = await token(beto, { channelId: voiceId });
    expect(doBeto.body.url).toBe("wss://principal.teste");
    await expect(new TokenVerifier("kp", "segredo-principal").verify(doBeto.body.token)).resolves.toBeTruthy();

    // outra sala, vazia (Ana muda para ela): nasce na reserva
    await sentar(port, ana, outraId);
    const daOutra = await token(ana, { channelId: outraId });
    expect(daOutra.body.url).toBe("wss://reserva.teste");
    await expect(new TokenVerifier("kf", "segredo-reserva").verify(daOutra.body.token)).resolves.toBeTruthy();
  });

  it("chamada de DM usa o mesmo mecanismo", async () => {
    const { ana, beto, port, pool } = await withMedia();
    const dm = (await ana.agent.post("/api/dms").send({ userId: beto.id })).body.dm;
    const wa = await connect(port, { Cookie: ana.cookie });
    const wb = await connect(port, { Cookie: beto.cookie });
    wa.ws.send(JSON.stringify({ type: "call.start", dmId: dm.id }));
    await wa.next();
    await wb.next();
    wb.ws.send(JSON.stringify({ type: "call.accept", dmId: dm.id }));
    await wa.next();
    await wb.next();

    const res = await token(ana, { dmId: dm.id });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("wss://principal.teste");
    await token(beto, { dmId: dm.id });
    expect(pool.serverOf(`call-${dm.id}`)).toBe("primary");

    wa.ws.send(JSON.stringify({ type: "call.hangup", dmId: dm.id }));
    await wa.next();
    expect(pool.serverOf(`call-${dm.id}`)).toBeUndefined(); // a chamada acabou: a sala some do pool
  });

  it("sair da sala (ou o canal ser apagado) libera a sala no pool", async () => {
    const { ana, port, pool, voiceId } = await withMedia();
    const c = await sentar(port, ana, voiceId);
    await token(ana, { channelId: voiceId });
    expect(pool.serverOf(`voice-${voiceId}`)).toBe("primary");
    c.ws.send(JSON.stringify({ type: "voice.leave" }));
    await c.next();
    expect(pool.serverOf(`voice-${voiceId}`)).toBeUndefined();
  });

  it("expulsar da sala usa as chaves do servidor DA SALA, mesmo com a principal fora do ar", async () => {
    const { ana, beto, port, voiceId, removed, derrubar, pool } = await withMedia();
    await sentar(port, beto, voiceId);
    await token(beto, { channelId: voiceId }); // sala nasce na principal
    await derrubar();
    expect(pool.primaryHealthy).toBe(false);

    const res = await ana.agent.post("/api/voice/kick").send({ userId: beto.id });
    expect(res.status).toBe(204);
    expect(removed).toEqual([{ cfg: primary, room: `voice-${voiceId}`, identity: String(beto.id) }]);
  });

  it("expulsar de uma sala que nasceu na reserva usa as chaves da reserva", async () => {
    const { ana, beto, port, voiceId, removed, derrubar } = await withMedia();
    await derrubar();
    await sentar(port, beto, voiceId);
    await token(beto, { channelId: voiceId });
    await ana.agent.post("/api/voice/kick").send({ userId: beto.id });
    expect(removed[0].cfg).toEqual(fallback);
  });

  it("avisa a administradora quando a principal cai e quando volta, e pode repetir no mesmo dia", async () => {
    const { app, pool, state } = await withMedia();
    const meter = meterOf(app);
    const ciclo = async () => {
      state.up = false;
      await pool.check();
      await pool.check();
      state.up = true;
      await pool.check();
      await pool.check();
    };
    await ciclo();
    const alertas = meter.alerts().reverse();
    expect(alertas.map((a) => [a.level, a.title])).toEqual([
      ["critico", "Servidor de voz próprio fora do ar"],
      ["aviso", "Servidor de voz próprio voltou"],
    ]);
    expect(alertas[0].message).toContain("reserva");
    expect(alertas[0].message).toContain("5.000");
    await new Promise((r) => setTimeout(r, 5)); // outra ocorrência no mesmo dia não é engolida pela chave anterior
    await ciclo();
    expect(meter.alerts()).toHaveLength(4);
  });

  it("sem principal configurada: tudo igual a hoje (reserva sempre)", async () => {
    const pool = new MediaPool({ primary: null, fallback }, async () => true);
    const { ana, port, voiceId } = await (async () => {
      const s = await scenario({ mediaPool: pool });
      const id = (await s.ana.agent.post(`/api/servers/${s.server.id}/channels`).send({ name: "sala", type: "voice" })).body.channel.id as number;
      return { ...s, voiceId: id };
    })();
    await sentar(port, ana, voiceId);
    const res = await token(ana, { channelId: voiceId });
    expect(res.body.url).toBe("wss://reserva.teste");
  });
});
