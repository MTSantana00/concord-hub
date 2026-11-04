import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, scenario, signup } from "./testkit.js";
import { MAX_IMAGE_BYTES } from "./images.js";

afterEach(closeAll);

const png = (extra = 100) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 7)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 5)]);
const webp = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(60, 3)]);

const upload = (agent: request.Agent, body: Buffer, type = "image/png") => agent.put("/api/profile/avatar").set("Content-Type", type).send(body);

describe("meu perfil", () => {
  it("começa sem nome de exibição, sem foto, disponível; /me já traz o perfil", async () => {
    const { ana } = await scenario();
    const r = await ana.agent.get("/api/profile");
    expect(r.body.profile).toEqual({ displayName: null, about: "", statusKind: "online", statusText: "", avatarVersion: 0 });
    expect((await ana.agent.get("/api/auth/me")).body.user).toMatchObject({ username: "ana", displayName: null, avatarVersion: 0 });
  });

  it("edita nome, sobre mim e status; limpa espaços; nome vazio volta ao usuário", async () => {
    const { ana } = await scenario();
    const r = await ana.agent.patch("/api/profile").send({ displayName: "  Ana   Paula ", about: "Gosto de   jogar\nà noite", statusKind: "dnd", statusText: " estudando " });
    expect(r.body.profile).toEqual({ displayName: "Ana Paula", about: "Gosto de jogar à noite", statusKind: "dnd", statusText: "estudando", avatarVersion: 0 });
    const limpo = await ana.agent.patch("/api/profile").send({ displayName: "   " });
    expect(limpo.body.profile.displayName).toBeNull();
    expect(limpo.body.profile.statusKind).toBe("dnd"); // o resto ficou
  });

  it("recusa dados inválidos", async () => {
    const { ana } = await scenario();
    for (const body of [{ displayName: "x".repeat(33) }, { displayName: 5 }, { about: "x".repeat(191) }, { statusKind: "invisivel" }, { statusKind: 1 }, { statusText: "x".repeat(61) }]) {
      expect((await ana.agent.patch("/api/profile").send(body)).status).toBe(400);
    }
    expect((await request((await scenario()).app).patch("/api/profile").send({ about: "x" })).status).toBe(401);
  });

  it("o perfil aparece na lista de membros, nas mensagens e na conversa direta", async () => {
    const { ana, beto, server, channelId } = await scenario();
    await beto.agent.patch("/api/profile").send({ displayName: "Beto Silva", statusKind: "away", statusText: "já volto" });
    const membros = (await ana.agent.get(`/api/servers/${server.id}/members`)).body.members;
    expect(membros.find((m: any) => m.username === "beto")).toMatchObject({ displayName: "Beto Silva", statusKind: "away", statusText: "já volto" });

    const msg = (await beto.agent.post(`/api/channels/${channelId}/messages`).send({ content: "oi" })).body.message;
    expect(msg.author).toMatchObject({ username: "beto", displayName: "Beto Silva", avatarVersion: 0 });
    const historico = (await ana.agent.get(`/api/channels/${channelId}/messages`)).body.messages;
    expect(historico[0].author.displayName).toBe("Beto Silva"); // quem mudou o nome depois: o histórico mostra o nome atual

    const dm = (await ana.agent.post("/api/dms").send({ userId: beto.id })).body.dm;
    expect(dm.user).toMatchObject({ username: "beto", displayName: "Beto Silva", statusKind: "away" });
  });

  it("os outros recebem o perfil novo em tempo real; quem não divide servidor não recebe", async () => {
    const { ana, beto, carla, port } = await scenario();
    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    const wsCarla = await connect(port, { Cookie: carla.cookie });
    await beto.agent.patch("/api/profile").send({ displayName: "Bê" });
    const esperado = { type: "profile.updated", userId: beto.id, profile: expect.objectContaining({ displayName: "Bê" }) };
    expect(await wsAna.next()).toMatchObject(esperado);
    expect(await wsBeto.next()).toMatchObject(esperado); // os outros aparelhos dele também
    await new Promise((r) => setTimeout(r, 100));
    expect(wsCarla.received).toEqual([]);
  });
});

describe("foto de perfil", () => {
  it("envia PNG, JPEG ou WebP; a versão sobe a cada troca", async () => {
    const { ana } = await scenario();
    expect((await upload(ana.agent, png())).body.profile.avatarVersion).toBe(1);
    expect((await upload(ana.agent, jpeg(), "image/jpeg")).body.profile.avatarVersion).toBe(2);
    expect((await upload(ana.agent, webp(), "image/webp")).body.profile.avatarVersion).toBe(3);
  });

  it("quem divide servidor baixa a foto (e o tipo vem dos bytes); de fora e sem foto levam 404", async () => {
    const { ana, beto, carla } = await scenario();
    expect((await beto.agent.get(`/api/profile/avatar/${ana.id}`)).status).toBe(404); // ainda sem foto
    const bytes = jpeg();
    await upload(ana.agent, bytes, "image/png"); // o cliente "disse" png, mas os bytes são JPEG
    const baixada = await beto.agent.get(`/api/profile/avatar/${ana.id}`).buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on("data", (c: Buffer) => parts.push(c));
      r.on("end", () => cb(null, Buffer.concat(parts)));
    });
    expect(baixada.status).toBe(200);
    expect(baixada.headers["content-type"]).toContain("image/jpeg");
    expect(baixada.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(baixada.body, bytes)).toBe(0);
    expect((await ana.agent.get(`/api/profile/avatar/${ana.id}`)).status).toBe(200); // a própria
    expect((await carla.agent.get(`/api/profile/avatar/${ana.id}`)).status).toBe(404); // não divide servidor
    expect((await ana.agent.get("/api/profile/avatar/abc")).status).toBe(404);
  });

  it("recusa o que não é imagem aceita, vazio e grande demais; sem login 401", async () => {
    const { app, ana } = await scenario();
    expect((await upload(ana.agent, Buffer.from("<script>alert(1)</script>"))).status).toBe(415);
    expect((await upload(ana.agent, Buffer.from("GIF89a" + "x".repeat(50)), "image/gif")).status).toBe(415);
    expect((await upload(ana.agent, Buffer.alloc(0))).status).toBe(415);
    expect((await ana.agent.put("/api/profile/avatar").send({ x: 1 })).status).toBe(415); // JSON
    expect((await upload(ana.agent, png(MAX_IMAGE_BYTES + 10))).status).toBe(413);
    expect((await ana.agent.get("/api/profile")).body.profile.avatarVersion).toBe(0); // nada foi gravado
    expect((await request(app).put("/api/profile/avatar").set("Content-Type", "image/png").send(png())).status).toBe(401);
  });

  it("remover a foto zera a versão e o arquivo some; os outros são avisados", async () => {
    const { ana, beto, port } = await scenario();
    await upload(ana.agent, png());
    const ws = await connect(port, { Cookie: beto.cookie });
    const r = await ana.agent.delete("/api/profile/avatar");
    expect(r.body.profile.avatarVersion).toBe(0);
    expect(await ws.next()).toMatchObject({ type: "profile.updated", userId: ana.id, profile: { avatarVersion: 0 } });
    expect((await beto.agent.get(`/api/profile/avatar/${ana.id}`)).status).toBe(404);
  });

  it("a foto de quem foi expulso deixa de ser visível para o servidor", async () => {
    const { ana, beto, server } = await scenario();
    await upload(beto.agent, png());
    expect((await ana.agent.get(`/api/profile/avatar/${beto.id}`)).status).toBe(200);
    await ana.agent.delete(`/api/servers/${server.id}/members/${beto.id}`);
    expect((await ana.agent.get(`/api/profile/avatar/${beto.id}`)).status).toBe(404);
  });

  it("cadastro novo também nasce com perfil padrão", async () => {
    const { app } = await scenario();
    const dani = await signup(app, "dani");
    expect((await dani.agent.get("/api/profile")).body.profile.avatarVersion).toBe(0);
  });
});
