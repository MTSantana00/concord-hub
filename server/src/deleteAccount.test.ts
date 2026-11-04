import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, pause, scenario } from "./testkit.js";

afterEach(closeAll);

const PASS = "senha-bem-longa";

describe("excluir a própria conta", () => {
  it("exige o nome de usuário e a senha; dono de servidor e administradora não podem", async () => {
    const { ana, beto } = await scenario();
    expect((await beto.agent.post("/api/auth/delete-account").send({ password: PASS })).status).toBe(400);
    expect((await beto.agent.post("/api/auth/delete-account").send({ confirm: "outro", password: PASS })).status).toBe(400);
    expect((await beto.agent.post("/api/auth/delete-account").send({ confirm: "beto", password: "errada-errada" })).status).toBe(403);
    expect((await beto.agent.post("/api/auth/delete-account").send({ confirm: "beto" })).status).toBe(403);
    expect((await beto.agent.get("/api/auth/me")).status).toBe(200); // nada foi apagado

    // administradora (a primeira conta) fica de fora
    expect((await ana.agent.post("/api/auth/delete-account").send({ confirm: "ana", password: PASS })).status).toBe(403);

    // quem é dono de um servidor precisa apagá-lo antes
    await beto.agent.post("/api/servers").send({ name: "Meu Canto" });
    const dono = await beto.agent.post("/api/auth/delete-account").send({ confirm: "beto", password: PASS });
    expect(dono.status).toBe(409);
    expect(dono.body.error).toContain("Meu Canto");
  });

  it("apaga a conta e tudo dela: login, mensagens, conversas e vaga nos servidores; avisa quem estava junto", async () => {
    const { ana, beto, port, server, channelId } = await scenario();
    await beto.agent.post(`/api/channels/${channelId}/messages`).send({ content: "oi, sou o beto" });
    await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: "oi, beto" });
    const dm = await beto.agent.post("/api/dms").send({ userId: ana.id });
    expect([200, 201]).toContain(dm.status);

    const wa = await connect(port, { Cookie: ana.cookie });
    const wb = await connect(port, { Cookie: beto.cookie });
    const fechou = new Promise<number>((resolve) => wb.ws.once("close", (code) => resolve(code)));

    const res = await beto.agent.post("/api/auth/delete-account").send({ confirm: "beto", password: PASS });
    expect(res.status).toBe(204);
    expect(await fechou).toBe(4001); // a conexão aberta da pessoa é fechada

    // quem ficou vê a saída e as mensagens dela somem
    expect(await wa.next()).toEqual({ type: "member.removed", serverId: server.id, userId: beto.id, reason: "left" });
    const msgs = (await ana.agent.get(`/api/channels/${channelId}/messages`)).body.messages as { content: string }[];
    expect(msgs.map((m) => m.content)).toEqual(["oi, beto"]);
    expect((await ana.agent.get(`/api/servers/${server.id}/members`)).body.members.map((m: any) => m.username)).toEqual(["ana"]);
    expect((await ana.agent.get("/api/dms")).body.dms).toEqual([]);

    // o login não existe mais, nem com a senha certa; o nome de usuário fica livre
    expect((await beto.agent.get("/api/auth/me")).status).toBe(401);
    expect((await beto.agent.post("/api/auth/login").send({ username: "beto", password: PASS })).status).toBe(401);
    await pause(50);
  });
});
