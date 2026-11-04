import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "./commands.js";
import { closeAll, connect, scenario } from "./testkit.js";

afterEach(closeAll);

describe("timeout de membro", () => {
  it("quem modera aplica; a pessoa não envia texto, enquete nem anexo, mas lê; tirar libera", async () => {
    const { ana, beto, port, server, channelId } = await scenario();
    const url = `/api/servers/${server.id}/members/${beto.id}/timeout`;
    const ws = await connect(port, { Cookie: ana.cookie });

    expect((await beto.agent.put(`/api/servers/${server.id}/members/${ana.id}/timeout`).send({ minutes: 5 })).status).toBe(403); // beto não modera
    expect((await ana.agent.put(`/api/servers/${server.id}/members/${ana.id}/timeout`).send({ minutes: 5 })).status).toBe(400); // consigo mesma
    expect((await ana.agent.put(url).send({ minutes: -1 })).status).toBe(400);
    expect((await ana.agent.put(url).send({ minutes: 1.5 })).status).toBe(400);
    expect((await ana.agent.put(url).send({ minutes: 99999 })).status).toBe(400);
    expect((await ana.agent.put(url).send({ minutes: "5" })).status).toBe(400);

    const ok = await ana.agent.put(url).send({ minutes: 10, reason: "spam" });
    expect(ok.status).toBe(200);
    expect(ok.body.timeoutUntil).toBeGreaterThan(Date.now() + 9 * 60_000);
    const evento = await ws.next();
    expect(evento).toMatchObject({ type: "member.timeout", serverId: server.id, userId: beto.id });

    const msg = await beto.agent.post(`/api/channels/${channelId}/messages`).send({ content: "oi" });
    expect(msg.status).toBe(403);
    expect(msg.body.error).toMatch(/timeout/);
    expect(msg.body.retryAfter).toBeGreaterThan(500);
    expect((await beto.agent.post(`/api/channels/${channelId}/polls`).send({ question: "q", options: ["a", "b"] })).status).toBe(403);
    expect((await beto.agent.post(`/api/channels/${channelId}/attachments?name=a.txt`).set("Content-Type", "text/plain").send("oi")).status).toBe(403);
    expect((await beto.agent.get(`/api/channels/${channelId}/messages`)).status).toBe(200); // ler pode
    expect((await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "ana pode" })).status).toBe(201);

    const lista = (await ana.agent.get(`/api/servers/${server.id}/members`)).body.members;
    expect(lista.find((m: any) => m.id === beto.id).timeoutUntil).toBe(ok.body.timeoutUntil);
    expect(lista.find((m: any) => m.id === ana.id).timeoutUntil).toBeNull();
    const log = (await ana.agent.get(`/api/servers/${server.id}/log`)).body.entries;
    expect(log[0].text).toMatch(/ana deixou em timeout beto \(10 min: spam\)/);

    expect((await ana.agent.put(url).send({ minutes: 0 })).body.timeoutUntil).toBeNull();
    expect((await beto.agent.post(`/api/channels/${channelId}/messages`).send({ content: "voltei" })).status).toBe(201);
  });

  it("o dono não pode ser silenciado; mensagem direta não é afetada", async () => {
    const { ana, beto, server, channelId } = await scenario();
    expect((await ana.agent.put(`/api/servers/${server.id}/members/${ana.id}/timeout`).send({ minutes: 5 })).status).toBe(400);
    expect((await beto.agent.put(`/api/servers/${server.id}/members/${ana.id}/timeout`).send({ minutes: 5 })).status).toBe(403);

    await ana.agent.put(`/api/servers/${server.id}/members/${beto.id}/timeout`).send({ minutes: 5 });
    const dm = (await beto.agent.post("/api/dms").send({ userId: ana.id })).body.dm;
    expect((await beto.agent.post(`/api/dms/${dm.id}/messages`).send({ content: "no privado vale" })).status).toBe(201);

    // e no canal continua bloqueado
    expect((await beto.agent.post(`/api/channels/${channelId}/messages`).send({ content: "no canal não" })).status).toBe(403);
  });
});

describe("comandos de barra", () => {
  it("texto comum e comando desconhecido passam sem mudar", () => {
    expect(runCommand("oi")).toBe("oi");
    expect(runCommand("/home/pasta")).toBe("/home/pasta");
    expect(runCommand("/qualquer coisa")).toBe("/qualquer coisa");
    expect(runCommand("1/2")).toBe("1/2");
  });

  it("/dado: padrão d6, NdM, limites e erros", () => {
    for (let i = 0; i < 50; i++) {
      const r = runCommand("/dado 2d6") as string;
      const m = /^🎲 rolou 2d6: (\d) \+ (\d) = \*\*(\d+)\*\*$/.exec(r)!;
      expect(m).not.toBeNull();
      expect(Number(m[1]) + Number(m[2])).toBe(Number(m[3]));
      expect(Number(m[1])).toBeGreaterThanOrEqual(1);
      expect(Number(m[1])).toBeLessThanOrEqual(6);
    }
    expect(runCommand("/dado")).toMatch(/^🎲 rolou d6: \*\*[1-6]\*\*$/);
    expect(runCommand("/dado d20")).toMatch(/^🎲 rolou d20: \*\*\d+\*\*$/);
    expect(runCommand("/DADO D20")).toMatch(/d20/);
    for (const ruim of ["/dado abc", "/dado 0d6", "/dado 11d6", "/dado d1", "/dado d1001", "/dado 2d"]) {
      expect(runCommand(ruim)).toHaveProperty("error");
    }
  });

  it("/moeda, /sortear, /spoiler, /me, /shrug", () => {
    expect(runCommand("/moeda")).toMatch(/^🪙 jogou a moeda: \*\*(cara|coroa)\*\*$/);
    const s = runCommand("/sortear pizza, sushi ; hambúrguer") as string;
    expect(s).toMatch(/^🎯 sorteou \*\*(pizza|sushi|hambúrguer)\*\* \(entre: pizza, sushi, hambúrguer\)$/);
    expect(runCommand("/sortear só um")).toHaveProperty("error");
    expect(runCommand("/sortear " + Array.from({ length: 26 }, (_, i) => `o${i}`).join(","))).toHaveProperty("error");
    expect(runCommand("/spoiler o final")).toBe("||o final||");
    expect(runCommand("/spoiler")).toHaveProperty("error");
    expect(runCommand("/spoiler a||b")).toHaveProperty("error");
    expect(runCommand("/me dança")).toBe("*dança*");
    expect(runCommand("/me")).toHaveProperty("error");
    expect(runCommand("/shrug")).toBe("¯\\_(ツ)_/¯");
    expect(runCommand("/shrug sei lá")).toBe("sei lá ¯\\_(ツ)_/¯");
  });

  it("pela API: vira a mensagem do autor no canal e na conversa direta; erro vira 400", async () => {
    const { ana, beto, channelId } = await scenario();
    const r = await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "/dado 3d4" });
    expect(r.status).toBe(201);
    expect(r.body.message.content).toMatch(/^🎲 rolou 3d4: \d \+ \d \+ \d = \*\*\d+\*\*$/);
    expect(r.body.message.author.id).toBe(ana.id);
    const ruim = await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "/dado xx" });
    expect(ruim.status).toBe(400);
    expect(ruim.body.error).toMatch(/\/dado/);

    const dm = (await ana.agent.post("/api/dms").send({ userId: beto.id })).body.dm;
    const d = await ana.agent.post(`/api/dms/${dm.id}/messages`).send({ content: "/moeda" });
    expect(d.status).toBe(201);
    expect(d.body.message.content).toMatch(/moeda/);
  });
});
