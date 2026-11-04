import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// getBuiltinModule porque o Vitest não resolve `import "node:sqlite"`
const sqlite = process.getBuiltinModule("node:sqlite");
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_AGE_MS, backupIfDue, createBackup, listBackups, KEEP_BACKUPS } from "./backup.js";
import { openDb } from "./db.js";
import { WindowCounter } from "./rateLimit.js";
import { closeAll, scenario, signup, start } from "./testkit.js";

afterEach(closeAll);

const temp = () => mkdtempSync(join(tmpdir(), "concord-test-"));

describe("contador de limite", () => {
  it("deixa passar até o máximo, depois diz em quantos segundos libera, e libera quando a janela passa", () => {
    let t = 1_000_000;
    const c = new WindowCounter(3, 10_000, () => t);
    expect([c.hit("a"), c.hit("a"), c.hit("a")]).toEqual([0, 0, 0]);
    expect(c.hit("a")).toBe(10);
    t += 4_000;
    expect(c.hit("a")).toBe(6);
    expect(c.hit("outro")).toBe(0); // cada chave tem a sua conta
    t += 6_000; // o primeiro acesso saiu da janela
    expect([c.hit("a"), c.hit("a"), c.hit("a")]).toEqual([0, 0, 0]); // os três antigos saíram da janela juntos
    expect(c.hit("a")).toBeGreaterThan(0);
  });
});

describe("limites anti-spam", () => {
  it("mensagens: o 13º envio em 10 s é recusado com 429, Retry-After e texto claro; outra pessoa não é afetada", async () => {
    const { ana, beto, channelId } = await scenario({ rateLimit: true });
    const url = `/api/channels/${channelId}/messages`;
    for (let i = 0; i < 12; i++) expect((await ana.agent.post(url).send({ content: `m${i}` })).status).toBe(201);
    const res = await ana.agent.post(url).send({ content: "demais" });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/rápido demais.*\d+ segundo/);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect((await ana.agent.get(`${url}`)).body.messages).toHaveLength(12); // a recusada não foi gravada
    expect((await beto.agent.post(url).send({ content: "oi" })).status).toBe(201);
  });

  it("anexos e áudios dividem o limite de 10 por minuto; reações têm o seu", async () => {
    const { ana, channelId } = await scenario({ rateLimit: true });
    const base = `/api/channels/${channelId}`;
    const file = Buffer.from("conteudo");
    for (let i = 0; i < 10; i++) {
      expect((await ana.agent.post(`${base}/attachments`).query({ name: `a${i}.txt` }).set("Content-Type", "application/octet-stream").send(file)).status).toBe(201);
    }
    expect((await ana.agent.post(`${base}/attachments`).query({ name: "x.txt" }).set("Content-Type", "application/octet-stream").send(file)).status).toBe(429);
    expect((await ana.agent.post(`${base}/audio?ms=500`).set("Content-Type", "audio/webm").send(file)).status).toBe(429);

    const msg = (await ana.agent.post(`${base}/messages`).send({ content: "reaja" })).body.message;
    for (let i = 0; i < 30; i++) {
      expect((await ana.agent.post(`${base}/messages/${msg.id}/reactions`).send({ emoji: "👍" })).status).toBe(200);
    }
    expect((await ana.agent.post(`${base}/messages/${msg.id}/reactions`).send({ emoji: "👍" })).status).toBe(429);
  });

  it("entrar: a 21ª tentativa em 15 min é recusada, mesmo com a senha certa; contas: 10 por hora", async () => {
    const { app } = await start({ rateLimit: true });
    for (let i = 0; i < 20; i++) {
      expect((await request(app).post("/api/auth/login").send({ username: "nao-existe", password: "errada-errada" })).status).toBe(401);
    }
    const bloqueada = await request(app).post("/api/auth/login").send({ username: "nao-existe", password: "errada-errada" });
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.body.error).toMatch(/Muitas tentativas de entrar/);

    for (let i = 0; i < 10; i++) {
      expect((await request(app).post("/api/auth/register").send({ username: `pessoa${i}`, password: "senha-boa-123" })).status).toBe(201);
    }
    expect((await request(app).post("/api/auth/register").send({ username: "pessoa10", password: "senha-boa-123" })).status).toBe(429);
  });

  it("sem estar logada o limite de mensagens não vira desculpa: continua 401", async () => {
    const { app, channelId } = Object.assign(await start({ rateLimit: true }), { channelId: 1 });
    expect((await request(app).post(`/api/channels/${channelId}/messages`).send({ content: "x" })).status).toBe(401);
  });

  it("desligado (padrão dos testes) não limita", async () => {
    const { ana, channelId } = await scenario();
    for (let i = 0; i < 20; i++) expect((await ana.agent.post(`/api/channels/${channelId}/messages`).send({ content: `m${i}` })).status).toBe(201);
  });
});

describe("backup automático", () => {
  it("cria uma cópia que abre, íntegra e com os dados; mantém só as 14 mais recentes", () => {
    const dir = temp();
    const db = openDb();
    db.exec("INSERT INTO users (username, password_hash) VALUES ('ana', 'x'), ('beto', 'x')");
    const name = createBackup(db, dir, new Date("2026-10-30T12:00:00Z"));
    expect(name).toBe("concord-20261030-120000.db");
    const copy = new sqlite.DatabaseSync(join(dir, name), { readOnly: true });
    expect((copy.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(2);
    expect((copy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBeGreaterThan(0);
    copy.close();

    for (let i = 1; i <= KEEP_BACKUPS + 3; i++) createBackup(db, dir, new Date(Date.UTC(2026, 10, i, 12)));
    const left = listBackups(dir);
    expect(left).toHaveLength(KEEP_BACKUPS);
    expect(left[0].name).toBe(`concord-202611${String(KEEP_BACKUPS + 3).padStart(2, "0")}-120000.db`); // do mais novo ao mais antigo
    expect(left.some((b) => b.name === "concord-20261030-120000.db")).toBe(false); // o mais velho saiu
    rmSync(dir, { recursive: true, force: true });
  });

  it("só cria outro quando o último tem mais de 24 h; ignora arquivos que não são backups", () => {
    const dir = temp();
    const db = openDb();
    writeFileSync(join(dir, "anotacao.txt"), "não mexer");
    const t0 = new Date("2026-10-30T12:00:00Z");
    expect(backupIfDue(db, dir, t0)).toBe("concord-20261030-120000.db");
    utimesSync(join(dir, "concord-20261030-120000.db"), t0, t0);
    expect(backupIfDue(db, dir, new Date(t0.getTime() + MAX_AGE_MS - 60_000))).toBeNull();
    expect(backupIfDue(db, dir, new Date(t0.getTime() + MAX_AGE_MS + 60_000))).toMatch(/^concord-20261031-/);
    expect(readdirSync(dir)).toContain("anotacao.txt");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("administração: backups", () => {
  it("a administradora lista os automáticos e baixa um novo, que abre e traz as contas", async () => {
    const dir = temp();
    createBackup(openDb(), dir, new Date("2026-10-30T12:00:00Z"));
    const { app, ana } = await scenario({ backupDir: dir });
    const lista = (await ana.agent.get("/api/admin/backups")).body.backups;
    expect(lista.map((b: any) => b.name)).toEqual(["concord-20261030-120000.db"]);

    const res = await ana.agent.get("/api/admin/backup").buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on("data", (c: Buffer) => parts.push(c));
      r.on("end", () => cb(null, Buffer.concat(parts)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="concord-\d{8}-\d{6}\.db"/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const file = join(dir, "baixado.db");
    writeFileSync(file, res.body);
    const copy = new sqlite.DatabaseSync(file, { readOnly: true });
    expect((copy.prepare("SELECT username FROM users ORDER BY id").all() as { username: string }[]).map((u) => u.username)).toEqual(["ana", "beto", "carla"]);
    copy.close();
    expect(app).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("só a administradora: outro membro 403, sem login 401", async () => {
    const { app, beto } = await scenario();
    expect((await beto.agent.get("/api/admin/backup")).status).toBe(403);
    expect((await beto.agent.get("/api/admin/backups")).status).toBe(403);
    expect((await request(app).get("/api/admin/backup")).status).toBe(401);
  });

  it("sem pasta de backups configurada a lista vem vazia (não quebra)", async () => {
    const { ana } = await scenario();
    expect((await ana.agent.get("/api/admin/backups")).body.backups).toEqual([]);
    expect(signup).toBeTruthy();
  });
});
