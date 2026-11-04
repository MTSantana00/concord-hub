import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, scenario } from "./testkit.js";

afterEach(closeAll);

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);

describe("nome do servidor", () => {
  it("o dono renomeia (com espaços limpos) e os membros são avisados; a lista de servidores mostra o novo nome", async () => {
    const { ana, beto, port, server } = await scenario();
    const ws = await connect(port, { Cookie: beto.cookie });
    const r = await ana.agent.patch(`/api/servers/${server.id}`).send({ name: "  Os   Craques " });
    expect(r.status).toBe(200);
    expect(r.body.server).toMatchObject({ id: server.id, name: "Os Craques" });
    expect(await ws.next()).toEqual({ type: "server.updated", serverId: server.id, name: "Os Craques", iconVersion: 0 });
    expect((await beto.agent.get("/api/servers")).body.servers[0]).toMatchObject({ name: "Os Craques", iconVersion: 0 });
  });

  it("só o dono; de fora 404; nome vazio ou grande demais 400", async () => {
    const { ana, beto, carla, server } = await scenario();
    const url = `/api/servers/${server.id}`;
    expect((await beto.agent.patch(url).send({ name: "Golpe" })).status).toBe(403);
    expect((await carla.agent.patch(url).send({ name: "Golpe" })).status).toBe(404);
    for (const name of ["", "   ", "x".repeat(51), 5, undefined]) {
      expect((await ana.agent.patch(url).send({ name })).status).toBe(400);
    }
  });
});

describe("ícone do servidor", () => {
  const put = (agent: any, url: string, body: Buffer, type = "image/png") => agent.put(url).set("Content-Type", type).send(body);

  it("o dono envia o ícone; membros baixam; de fora 404; a versão sobe e vai na lista de servidores", async () => {
    const { ana, beto, carla, server } = await scenario();
    const url = `/api/servers/${server.id}/icon`;
    expect((await beto.agent.get(url)).status).toBe(404); // ainda sem ícone
    const r = await put(ana.agent, url, png());
    expect(r.body.server.iconVersion).toBe(1);
    expect((await put(ana.agent, url, png())).body.server.iconVersion).toBe(2);
    const baixado = await beto.agent.get(url);
    expect(baixado.status).toBe(200);
    expect(baixado.headers["content-type"]).toContain("image/png");
    expect((await carla.agent.get(url)).status).toBe(404);
    expect((await beto.agent.get("/api/servers")).body.servers[0].iconVersion).toBe(2);
  });

  it("só o dono envia ou remove; arquivo que não é imagem é recusado; remover zera", async () => {
    const { ana, beto, server } = await scenario();
    const url = `/api/servers/${server.id}/icon`;
    expect((await put(beto.agent, url, png())).status).toBe(403);
    expect((await put(ana.agent, url, Buffer.from("não sou imagem"))).status).toBe(415);
    await put(ana.agent, url, png());
    expect((await beto.agent.delete(url)).status).toBe(403);
    expect((await ana.agent.delete(url)).body.server.iconVersion).toBe(0);
    expect((await beto.agent.get(url)).status).toBe(404);
  });
});
