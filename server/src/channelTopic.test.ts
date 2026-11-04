import { afterEach, describe, expect, it } from "vitest";
import { closeAll, scenario } from "./testkit.js";

afterEach(closeAll);

describe("tópico do canal", () => {
  it("quem gerencia canais define; todos veem; valida tamanho e tipo; limpa espaços e controles", async () => {
    const { ana, beto, server, channelId } = await scenario();
    const url = `/api/servers/${server.id}/channels/${channelId}`;
    const vistoPeloBeto = async () => (await beto.agent.get("/api/servers")).body.servers[0].channels.find((c: any) => c.id === channelId);

    expect((await vistoPeloBeto()).topic).toBe("");
    expect((await beto.agent.patch(url).send({ topic: "x" })).status).toBe(403);
    expect((await ana.agent.patch(url).send({ topic: 5 })).status).toBe(400);
    expect((await ana.agent.patch(url).send({ topic: "a".repeat(201) })).status).toBe(400);

    expect((await ana.agent.patch(url).send({ topic: "  Papo livre\ndo grupo  " })).status).toBe(200);
    expect((await vistoPeloBeto()).topic).toBe("Papo livre do grupo");

    // outras opções não apagam o tópico; só enviar topic vazio apaga
    expect((await ana.agent.patch(url).send({ slowmodeSeconds: 5 })).status).toBe(200);
    expect((await vistoPeloBeto()).topic).toBe("Papo livre do grupo");
    expect((await ana.agent.patch(url).send({ topic: "" })).status).toBe(200);
    expect((await vistoPeloBeto()).topic).toBe("");
    expect((await ana.agent.patch(url).send({ topic: "a".repeat(200) })).status).toBe(200);
  });
});
