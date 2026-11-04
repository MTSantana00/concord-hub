import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

const cfg = { jwtSecret: "teste", secureCookies: false };
const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // o Windows às vezes segura a pasta temporária; não importa para o teste
    }
  }
});

function clienteFalso() {
  const dir = mkdtempSync(join(tmpdir(), "concord-client-"));
  pastas.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Concord Hub</title><div id=root></div>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log('oi')");
  writeFileSync(join(dir, "sw.js"), "// sw");
  writeFileSync(join(dir, "manifest.webmanifest"), '{"name":"Concord Hub"}');
  return dir;
}

describe("servidor entrega o cliente compilado", () => {
  it("serve o index.html na raiz e em endereços do app, como /convite/<código>", async () => {
    const app = createApp({ db: openDb(), ...cfg, clientDir: clienteFalso() });
    for (const url of ["/", "/convite/abc123", "/qualquer/coisa"]) {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text).toContain("Concord Hub");
      expect(res.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("serve os arquivos de assets e mantém a API funcionando", async () => {
    const app = createApp({ db: openDb(), ...cfg, clientDir: clienteFalso() });
    const asset = await request(app).get("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");
    expect((await request(app).get("/api/health")).body).toEqual({ status: "ok" });
  });

  it("o manifesto e o service worker do app instalável são servidos e sempre relidos (sem cache)", async () => {
    const app = createApp({ db: openDb(), ...cfg, clientDir: clienteFalso() });
    const manifesto = await request(app).get("/manifest.webmanifest");
    expect(manifesto.status).toBe(200);
    expect(manifesto.headers["content-type"]).toContain("manifest+json");
    expect(manifesto.headers["cache-control"]).toBe("no-cache");
    const sw = await request(app).get("/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers["content-type"]).toContain("javascript");
    expect(sw.headers["cache-control"]).toBe("no-cache");
    // os outros arquivos continuam com cache de 1 hora
    expect((await request(app).get("/assets/app.js")).headers["cache-control"]).toBe("public, max-age=31536000, immutable"); // tem hash no nome
  });

  it("endereço de API que não existe é 404 e não vira index.html", async () => {
    const app = createApp({ db: openDb(), ...cfg, clientDir: clienteFalso() });
    const res = await request(app).get("/api/nao-existe");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("Concord Hub");
  });

  it("sem pasta do cliente (ou sem index.html) o servidor é só API", async () => {
    const semPasta = createApp({ db: openDb(), ...cfg });
    expect((await request(semPasta).get("/")).status).toBe(404);
    const vazia = mkdtempSync(join(tmpdir(), "concord-vazia-"));
    pastas.push(vazia);
    expect((await request(createApp({ db: openDb(), ...cfg, clientDir: vazia })).get("/")).status).toBe(404);
  });
});

describe("cadastro só por convite (INVITE_ONLY)", () => {
  const novo = { username: "amigo", password: "senha-bem-longa" };

  async function comConvite(inviteOnly: boolean) {
    const app = createApp({ db: openDb(), ...cfg, inviteOnly });
    // o primeiro usuário só existe aqui porque o banco é novo: cria-se direto, sem passar pela regra
    const db = (app.locals.hub as { db: ReturnType<typeof openDb> }).db;
    db.exec("INSERT INTO users (username, password_hash) VALUES ('dono', 'x')");
    db.exec("INSERT INTO servers (name, owner_id) VALUES ('Os Parças', 1)");
    db.exec("INSERT INTO invites (code, server_id, created_by) VALUES ('codigo-bom', 1, 1)");
    return app;
  }

  it("fechado: sem código, com código errado ou que não é texto é recusado (403) e nada é criado", async () => {
    const app = await comConvite(true);
    for (const inviteCode of [undefined, "", "errado", 123, null, { x: 1 }]) {
      const res = await request(app).post("/api/auth/register").send({ ...novo, inviteCode });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("só por convite");
    }
    expect((await request(app).post("/api/auth/login").send(novo)).status).toBe(401); // não foi criado
  });

  it("fechado: com um convite que existe, cria a conta e entra", async () => {
    const app = await comConvite(true);
    const res = await request(app).post("/api/auth/register").send({ ...novo, inviteCode: "codigo-bom" });
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe("amigo");
    expect(String(res.headers["set-cookie"])).toContain("concord_session");
  });

  it("fechado: login de quem já tem conta continua livre", async () => {
    const app = await comConvite(true);
    await request(app).post("/api/auth/register").send({ ...novo, inviteCode: "codigo-bom" });
    expect((await request(app).post("/api/auth/login").send(novo)).status).toBe(200);
  });

  it("aberto (padrão): não exige código", async () => {
    const app = await comConvite(false);
    expect((await request(app).post("/api/auth/register").send(novo)).status).toBe(201);
  });
});

describe("primeira conta (o dono) num servidor fechado e vazio", () => {
  const dono = { username: "dono", password: "senha-bem-longa" };
  const codigo = "codigo-secreto-de-setup";

  it("sem o código de configuração ninguém cria a primeira conta; com ele, o dono entra", async () => {
    const app = createApp({ db: openDb(), ...cfg, inviteOnly: true, setupCode: codigo });
    expect((await request(app).post("/api/auth/register").send(dono)).status).toBe(403);
    expect((await request(app).post("/api/auth/register").send({ ...dono, inviteCode: "chute" })).status).toBe(403);
    expect((await request(app).post("/api/auth/register").send({ ...dono, inviteCode: codigo })).status).toBe(201);
  });

  it("depois da primeira conta o código de configuração para de valer", async () => {
    const app = createApp({ db: openDb(), ...cfg, inviteOnly: true, setupCode: codigo });
    await request(app).post("/api/auth/register").send({ ...dono, inviteCode: codigo });
    const res = await request(app).post("/api/auth/register").send({ username: "intruso", password: "senha-bem-longa", inviteCode: codigo });
    expect(res.status).toBe(403);
  });

  it("sem código configurado, um servidor fechado e vazio não aceita ninguém", async () => {
    const app = createApp({ db: openDb(), ...cfg, inviteOnly: true });
    expect((await request(app).post("/api/auth/register").send({ ...dono, inviteCode: codigo })).status).toBe(403);
    expect((await request(app).post("/api/auth/register").send({ ...dono, inviteCode: undefined })).status).toBe(403);
  });

  it("o dono convida e o amigo entra; quem não tem convite continua de fora, mesmo sabendo o código de configuração", async () => {
    const app = createApp({ db: openDb(), ...cfg, inviteOnly: true, setupCode: codigo });
    const ana = request.agent(app);
    await ana.post("/api/auth/register").send({ ...dono, inviteCode: codigo });
    const server = (await ana.post("/api/servers").send({ name: "Os Parças" })).body.server;
    const { code } = (await ana.post(`/api/servers/${server.id}/invites`)).body;

    const amigo = request(app);
    expect((await amigo.post("/api/auth/register").send({ username: "beto", password: "senha-bem-longa", inviteCode: codigo })).status).toBe(403);
    expect((await amigo.post("/api/auth/register").send({ username: "beto", password: "senha-bem-longa" })).status).toBe(403);
    expect((await amigo.post("/api/auth/register").send({ username: "beto", password: "senha-bem-longa", inviteCode: code })).status).toBe(201);
    // quem nunca teve convite não consegue nem entrar
    expect((await amigo.post("/api/auth/login").send({ username: "carla", password: "senha-bem-longa" })).status).toBe(401);
  });
});
