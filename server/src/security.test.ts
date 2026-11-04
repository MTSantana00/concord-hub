import jwt from "jsonwebtoken";
import request from "supertest";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { PUSH_HOSTS } from "./routes/push.js";
import { closeAll, pause, scenario, start } from "./testkit.js";

afterEach(closeAll);

const keys = { p256dh: "p".repeat(20), auth: "a".repeat(20) };

describe("WebSocket", () => {
  it("Origin malformado ou de outro site é recusado sem derrubar o servidor", async () => {
    const { port, ana, app } = await scenario();
    for (const origin of ["isto não é um endereço", "http://", "https://site-de-fora.com", "null"]) {
      const status = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: ana.cookie, Origin: origin } });
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => {
          ws.close();
          resolve(200);
        });
        ws.on("error", () => resolve(-1));
      });
      expect([403, -1], origin).toContain(status);
    }
    await pause(100);
    expect((await ana.agent.get("/api/health")).status).toBe(200); // o servidor continua de pé
    expect(app).toBeTruthy();
  });

  it("sem cookie 401; com o mesmo host de origem entra", async () => {
    const { port, ana } = await scenario();
    const tenta = (headers: Record<string, string>) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers });
        ws.on("unexpected-response", (_r, res) => resolve(String(res.statusCode)));
        ws.on("open", () => {
          ws.close();
          resolve("aberto");
        });
        ws.on("error", () => resolve("erro"));
      });
    expect(await tenta({})).toBe("401");
    expect(await tenta({ Cookie: ana.cookie, Origin: `http://localhost:${port}` })).toBe("aberto");
  });
});

describe("sessão", () => {
  it("só aceita o algoritmo HS256: token 'none' ou assinado com outro algoritmo não vale", async () => {
    const { app, ana } = await scenario();
    const segredo = "teste"; // o mesmo do testkit
    const claims = { sub: String(ana.id), ver: 0 };
    const sem = jwt.sign(claims, "", { algorithm: "none" });
    const hs384 = jwt.sign(claims, segredo, { algorithm: "HS384" });
    const ok = jwt.sign(claims, segredo, { algorithm: "HS256" });
    const com = (t: string) => request(app).get("/api/auth/me").set("Cookie", `concord_session=${t}`);
    expect((await com(sem)).status).toBe(401);
    expect((await com(hs384)).status).toBe(401);
    expect((await com(ok)).status).toBe(200);
    expect((await com(`${ok}x`)).status).toBe(401);
  });
});

describe("cabeçalhos de segurança", () => {
  it("em produção: CSP restritiva (só o próprio site e o servidor de mídia), sem moldura, permissões e HSTS", async () => {
    const { app } = await start({ securityHeaders: { connect: ["wss://sala.livekit.cloud", "https://sala.livekit.cloud"] } });
    const h = (await request(app).get("/api/health")).headers;
    const csp = h["content-security-policy"] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'"); // sem script inline nem de fora
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("connect-src 'self' wss://sala.livekit.cloud https://sala.livekit.cloud");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(h["permissions-policy"]).toContain("camera=(self)");
    expect(h["permissions-policy"]).toContain("geolocation=()");
    expect(h["strict-transport-security"]).toContain("max-age=");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("same-origin");
  });

  it("no desenvolvimento a CSP não é aplicada (o Vite precisa de scripts em linha)", async () => {
    const { app } = await start();
    expect((await request(app).get("/api/health")).headers["content-security-policy"]).toBeUndefined();
  });
});

describe("notificações: só para serviços de push dos navegadores", () => {
  it("lista de endereços aceitos", () => {
    for (const ok of ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "api.push.apple.com", "wns2-par02p.notify.windows.com", "android.googleapis.com"]) {
      expect(PUSH_HOSTS.test(ok), ok).toBe(true);
    }
    for (const bad of ["localhost", "127.0.0.1", "10.0.0.5", "169.254.169.254", "exemplo.com", "fcm.googleapis.com.evil.com", "evil-fcm.googleapis.com", "push.apple.com.evil.com", "notify.windows.com.evil.net", "metadata.google.internal"]) {
      expect(PUSH_HOSTS.test(bad), bad).toBe(false);
    }
  });

  it("recusa assinatura com endereço interno, porta diferente ou credenciais", async () => {
    const s = await scenario({ push: { publicKey: "k", privateKey: "p", subject: "mailto:a@b.c" } });
    const tenta = (endpoint: string) => s.ana.agent.post("/api/push/subscribe").send({ endpoint, keys });
    expect((await tenta("https://fcm.googleapis.com/fcm/send/abc")).status).toBe(204);
    for (const bad of [
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.2/x",
      "https://servidor-interno.local/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:senha@fcm.googleapis.com/x",
      "https://fcm.googleapis.com.evil.com/x",
      "http://fcm.googleapis.com/x",
    ]) {
      expect((await tenta(bad)).status, bad).toBe(400);
    }
  });
});

describe("permissões em canais privados (varredura geral)", () => {
  it("quem não enxerga o canal recebe 404 em TODAS as rotas que usam o id dele", async () => {
    const { ana, beto } = await scenario();
    const b = `/api/servers/${(await beto.agent.get("/api/servers")).body.servers[0].id}`;
    const secreto = (await ana.agent.post(`${b}/channels`).send({ name: "secreto", private: true })).body.channel.id as number;
    const m = (await ana.agent.post(`/api/channels/${secreto}/messages`).send({ content: "segredo" })).body.message;
    const anexo = (await ana.agent.post(`/api/channels/${secreto}/attachments`).query({ name: "a.txt" }).set("Content-Type", "application/octet-stream").send(Buffer.from("conteudo"))).body.message;
    const c = `/api/channels/${secreto}`;
    const proibidas: [string, string, object?][] = [
      ["get", `${c}/messages`],
      ["post", `${c}/messages`, { content: "x" }],
      ["patch", `${c}/messages/${m.id}`, { content: "x" }],
      ["delete", `${c}/messages/${m.id}`],
      ["post", `${c}/messages/${m.id}/reactions`, { emoji: "👍" }],
      ["put", `${c}/messages/${m.id}/pin`],
      ["delete", `${c}/messages/${m.id}/pin`],
      ["get", `${c}/pins`],
      ["get", `${c}/search?q=segredo`],
      ["put", `${c}/read`],
      ["put", `/api/mutes/channel/${secreto}`],
      ["get", `/api/files/${anexo.id}`],
    ];
    for (const [metodo, url, corpo] of proibidas) {
      const r = await (beto.agent as any)[metodo](url).send(corpo);
      expect(r.status, `${metodo} ${url}`).toBe(404);
    }
  });
});
