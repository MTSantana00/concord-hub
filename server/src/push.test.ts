import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SUBSCRIPTIONS_PER_USER, generateKeys } from "./push.js";
import { closeAll, connect, pause, scenario } from "./testkit.js";

afterEach(closeAll);

const cfg = { publicKey: "chave-publica-de-teste", privateKey: "privada", subject: "mailto:teste@exemplo.com" };
const keys = { p256dh: "p".repeat(20), auth: "a".repeat(20) };
const endpoint = (n: number | string) => `https://fcm.googleapis.com/fcm/send/${n}`;

async function setup() {
  const sent: { endpoint: string; payload: any }[] = [];
  const failWith: { status: number | null } = { status: null };
  const pushSender = async (sub: { endpoint: string }, payload: string) => {
    if (failWith.status) throw Object.assign(new Error("falhou"), { statusCode: failWith.status });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  };
  const s = await scenario({ push: cfg, pushSender });
  const subscribe = (who: { agent: request.Agent }, n: number | string) => who.agent.post("/api/push/subscribe").send({ endpoint: endpoint(n), keys });
  const dm = (await s.ana.agent.post("/api/dms").send({ userId: s.beto.id })).body.dm.id as number;
  return { ...s, sent, failWith, subscribe, dm, canal: `/api/channels/${s.channelId}` };
}

describe("assinatura", () => {
  it("devolve a chave pública; sem chaves configuradas o recurso fica desligado; exige login", async () => {
    const { app, ana } = await setup();
    expect((await ana.agent.get("/api/push/key")).body).toEqual({ publicKey: cfg.publicKey });
    expect((await request(app).get("/api/push/key")).status).toBe(401);

    const off = await scenario();
    expect((await off.ana.agent.get("/api/push/key")).body).toEqual({ publicKey: null });
    expect((await off.ana.agent.post("/api/push/subscribe").send({ endpoint: endpoint(1), keys })).status).toBe(503);
  });

  it("assinar, repetir e cancelar; recusa endereço que não é https ou chaves malformadas", async () => {
    const { ana, subscribe } = await setup();
    expect((await subscribe(ana, 1)).status).toBe(204);
    expect((await subscribe(ana, 1)).status).toBe(204); // repetir não duplica
    expect((await ana.agent.delete("/api/push/subscribe").send({ endpoint: endpoint(1) })).status).toBe(204);
    for (const body of [
      { endpoint: "http://inseguro.com/x", keys },
      { endpoint: "não é url", keys },
      { endpoint: endpoint(2) },
      { endpoint: endpoint(2), keys: { p256dh: "curto", auth: keys.auth } },
      { endpoint: endpoint(2), keys: { p256dh: "<script>".repeat(4), auth: keys.auth } },
      { endpoint: `https://x.com/${"a".repeat(2100)}`, keys },
      { keys },
    ]) {
      expect((await ana.agent.post("/api/push/subscribe").send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await ana.agent.delete("/api/push/subscribe").send({})).status).toBe(400);
  });

  it("o mesmo aparelho passa para a conta que entrou nele; cada pessoa guarda no máximo 10 aparelhos", async () => {
    const { ana, beto, sent, dm, subscribe } = await setup();
    await subscribe(ana, "aparelho");
    await subscribe(beto, "aparelho"); // o mesmo navegador, agora na conta do Beto
    await ana.agent.post(`/api/dms/${dm}/messages`).send({ content: "oi" });
    await pause(80);
    expect(sent.map((s) => s.endpoint)).toEqual([endpoint("aparelho")]); // chegou para o Beto (dono atual), uma vez

    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER + 3; i++) await subscribe(beto, i);
    sent.length = 0;
    await ana.agent.post(`/api/dms/${dm}/messages`).send({ content: "de novo" });
    await pause(80);
    expect(sent).toHaveLength(MAX_SUBSCRIPTIONS_PER_USER); // os mais antigos saíram
    expect(sent.some((s) => s.endpoint === endpoint(0))).toBe(false);
  });
});

describe("quem recebe notificação com o app fechado", () => {
  it("mensagem direta: vai para o outro lado (todos os aparelhos dele), com quem mandou e o texto", async () => {
    const { ana, beto, sent, dm, subscribe } = await setup();
    await subscribe(beto, 1);
    await subscribe(beto, 2);
    await ana.agent.post(`/api/dms/${dm}/messages`).send({ content: "vamos jogar hoje à noite?" });
    await pause(80);
    expect(sent.map((s) => s.endpoint).sort()).toEqual([endpoint(1), endpoint(2)]);
    expect(sent[0].payload).toEqual({ title: "ana", body: "vamos jogar hoje à noite?", tag: `dm-${dm}` });
  });

  it("canal: só menção avisa; mensagem comum não; a menção diz o canal e o servidor; apelido e nome de exibição valem", async () => {
    const { ana, beto, sent, canal, subscribe, server } = await setup();
    await subscribe(beto, 1);
    await ana.agent.post(`${canal}/messages`).send({ content: "bom dia a todos" });
    await ana.agent.post(`${canal}/messages`).send({ content: "olha @beto, reunião" });
    await ana.agent.post(`${canal}/messages`).send({ content: "e @betoniera? não é você" });
    await pause(80);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ title: "ana em #geral (Os Parças)", body: "olha @beto, reunião" });

    await ana.agent.put(`/api/servers/${server.id}/nickname`).send({ nickname: "Chefa" });
    sent.length = 0;
    await ana.agent.post(`${canal}/messages`).send({ content: "@beto de novo" });
    await pause(80);
    expect(sent[0].payload.title).toBe("Chefa em #geral (Os Parças)");
  });

  it("anexo e áudio viram texto curto; textos grandes são cortados", async () => {
    const { ana, beto, sent, dm, subscribe } = await setup();
    await subscribe(beto, 1);
    await ana.agent.post(`/api/dms/${dm}/attachments`).query({ name: "a.pdf" }).set("Content-Type", "application/octet-stream").send(Buffer.from("x"));
    await ana.agent.post(`/api/dms/${dm}/audio?ms=800`).set("Content-Type", "audio/webm").send(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 7)]));
    await ana.agent.post(`/api/dms/${dm}/messages`).send({ content: "z".repeat(500) });
    await pause(120);
    const bodies = sent.map((s) => s.payload.body);
    expect(bodies).toContain("enviou um arquivo");
    expect(bodies).toContain("enviou uma mensagem de voz");
    expect(bodies.find((b: string) => b.startsWith("zzz"))).toHaveLength(120);
  });

  it("com o app aberto não manda; em 'Não perturbe' não manda; silenciado (conversa, canal ou servidor) não manda", async () => {
    const { ana, beto, port, sent, dm, canal, channelId, server, subscribe } = await setup();
    await subscribe(beto, 1);
    const manda = async () => {
      sent.length = 0;
      await ana.agent.post(`/api/dms/${dm}/messages`).send({ content: "oi" });
      await ana.agent.post(`${canal}/messages`).send({ content: "@beto oi" });
      await pause(80);
      return sent.length;
    };
    expect(await manda()).toBe(2);

    const ws = await connect(port, { Cookie: beto.cookie });
    expect(await manda()).toBe(0); // app aberto
    ws.ws.close();
    await pause(100);
    expect(await manda()).toBe(2);

    await beto.agent.patch("/api/profile").send({ statusKind: "dnd" });
    expect(await manda()).toBe(0);
    await beto.agent.patch("/api/profile").send({ statusKind: "online" });
    expect(await manda()).toBe(2);

    await beto.agent.put(`/api/mutes/dm/${dm}`);
    expect(await manda()).toBe(1); // só a menção no canal
    await beto.agent.put(`/api/mutes/channel/${channelId}`);
    expect(await manda()).toBe(0);
    await beto.agent.delete(`/api/mutes/channel/${channelId}`);
    await beto.agent.delete(`/api/mutes/dm/${dm}`);
    await beto.agent.put(`/api/mutes/server/${server.id}`);
    expect(await manda()).toBe(1); // o servidor silenciado cala o canal; a conversa direta continua
  });

  it("canal privado: a menção a quem não enxerga o canal não vira notificação; ninguém avisa a si mesmo", async () => {
    const { ana, beto, sent, subscribe, base } = await (async () => {
      const x = await setup();
      return { ...x, base: `/api/servers/${x.server.id}` };
    })();
    await subscribe(beto, 1);
    await subscribe(ana, 2);
    const secreto = (await ana.agent.post(`${base}/channels`).send({ name: "diretoria", private: true })).body.channel;
    await ana.agent.post(`/api/channels/${secreto.id}/messages`).send({ content: "@beto você não deveria ver isto" });
    await ana.agent.post(`/api/channels/${secreto.id}/messages`).send({ content: "@ana falando comigo mesma" });
    await pause(80);
    expect(sent).toHaveLength(0);
  });

  it("assinatura que o aparelho recusou (404/410) é apagada; outro erro só é ignorado", async () => {
    const { ana, beto, sent, failWith, dm, subscribe } = await setup();
    await subscribe(beto, 1);
    failWith.status = 500;
    await ana.agent.post(`/api/dms/${dm}/messages`).send({ content: "um" });
    await pause(80);
    failWith.status = null;
    await ana.agent.post(`/api/dms/${dm}/messages`).send({ content: "dois" });
    await pause(80);
    expect(sent).toHaveLength(1); // a falha 500 não apagou a assinatura

    failWith.status = 410;
    await ana.agent.post(`/api/dms/${dm}/messages`).send({ content: "três" });
    await pause(80);
    failWith.status = null;
    await ana.agent.post(`/api/dms/${dm}/messages`).send({ content: "quatro" });
    await pause(80);
    expect(sent).toHaveLength(1); // a 410 apagou: nada mais chega
    expect((await ana.agent.post(`/api/dms/${dm}/messages`).send({ content: "o chat segue funcionando" })).status).toBe(201);
  });

  it("sem chaves configuradas nada é enviado e o chat funciona normal", async () => {
    const s = await scenario();
    const dm = (await s.ana.agent.post("/api/dms").send({ userId: s.beto.id })).body.dm.id;
    expect((await s.ana.agent.post(`/api/dms/${dm}/messages`).send({ content: "oi" })).status).toBe(201);
  });
});

describe("chaves", () => {
  it("o par gerado tem o formato que o navegador espera (chave pública de 65 bytes, ponto não comprimido)", () => {
    const k = generateKeys();
    const pub = Buffer.from(k.publicKey, "base64url");
    expect(pub).toHaveLength(65);
    expect(pub[0]).toBe(0x04);
    expect(Buffer.from(k.privateKey, "base64url")).toHaveLength(32);
    expect(generateKeys().publicKey).not.toBe(k.publicKey);
  });
});

describe("ligação com o app fechado", () => {
  const ligar = (c: { ws: { send(d: string): void } }, dmId: number) => c.ws.send(JSON.stringify({ type: "call.start", dmId }));
  /** O próximo evento que não seja só uma mudança de perfil de alguém. */
  const proximo = async (c: { next(): Promise<any> }) => {
    for (;;) {
      const e = await c.next();
      if (e.type !== "profile.updated") return e;
    }
  };

  it("quem tem o aparelho assinado é avisado por notificação; ao abrir o app a chamada ainda toca e dá para atender", async () => {
    const { port, ana, beto, sent, dm, subscribe } = await setup();
    await subscribe(beto, "celular-do-beto");
    const wa = await connect(port, { Cookie: ana.cookie });

    ligar(wa, dm); // o Beto está com o app fechado (nenhuma conexão)
    expect((await wa.next()).type).toBe("call.ringing"); // quem liga vê "chamando"
    await pause(80);
    expect(sent).toHaveLength(1);
    expect(sent[0].endpoint).toBe(endpoint("celular-do-beto"));
    expect(sent[0].payload).toEqual({ title: "📞 ana está ligando", body: "Toque para atender", tag: `call-${dm}`, kind: "call" });

    // o Beto toca na notificação: o app abre e a chamada que ainda toca aparece para ele
    const wb = await connect(port, { Cookie: beto.cookie });
    const ring = await wb.next();
    expect(ring).toMatchObject({ type: "call.ringing", dmId: dm, from: { username: "ana" }, to: { username: "beto" } });
    wb.ws.send(JSON.stringify({ type: "call.accept", dmId: dm }));
    expect((await wb.next()).type).toBe("call.accepted");
    expect((await wa.next()).type).toBe("call.accepted");
  });

  it("com o app aberto não manda notificação; sem aparelho assinado ou em 'Não perturbe' continua 'offline'", async () => {
    const { port, ana, beto, sent, dm, subscribe } = await setup();
    const wa = await connect(port, { Cookie: ana.cookie });

    // sem assinatura e sem app aberto: offline, como antes
    ligar(wa, dm);
    expect(await proximo(wa)).toEqual({ type: "error", error: "A pessoa está offline" });

    // com assinatura mas em "Não perturbe": também não toca
    await subscribe(beto, 1);
    await beto.agent.patch("/api/profile").send({ statusKind: "dnd" });
    ligar(wa, dm);
    expect(await proximo(wa)).toEqual({ type: "error", error: "A pessoa está offline" });

    // com o app aberto quem avisa é a própria página: nenhuma notificação
    await beto.agent.patch("/api/profile").send({ statusKind: "online" });
    const wb = await connect(port, { Cookie: beto.cookie });
    ligar(wa, dm);
    expect((await proximo(wa)).type).toBe("call.ringing");
    expect((await proximo(wb)).type).toBe("call.ringing");
    await pause(80);
    expect(sent).toHaveLength(0);
  });
});
