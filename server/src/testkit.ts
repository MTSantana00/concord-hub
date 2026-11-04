// Ferramentas compartilhadas pelos testes que usam WebSocket de verdade.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import WebSocket from "ws";
import { createApp, hubOf } from "./app.js";
import { openDb } from "./db.js";
import type { MediaPool } from "./mediaPool.js";
import type { RoomServiceFactory } from "./routes/voiceToken.js";
import { attachRealtime } from "./realtime.js";

const cfg = { jwtSecret: "teste", secureCookies: false };
const servers: Server[] = [];
const sockets: WebSocket[] = [];

/** Use em `afterEach`: fecha todos os sockets e servidores abertos pelo teste. */
export function closeAll() {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of servers.splice(0)) s.close();
}

export async function start(opts: { offlineGraceMs?: number; ringMs?: number; inviteOnly?: boolean; setupCode?: string; inviteLimit?: number; linkFetcher?: (url: string) => Promise<any>; rateLimit?: boolean; backupDir?: string; push?: any; pushSender?: any; securityHeaders?: { connect: string[] }; usage?: any; oauth?: any; mediaPool?: MediaPool; makeRoomService?: RoomServiceFactory } = {}) {
  const app = createApp({ db: openDb(), ...cfg, offlineGraceMs: opts.offlineGraceMs ?? 0,
    mediaPool: opts.mediaPool,
    makeRoomService: opts.makeRoomService,
    ringMs: opts.ringMs,
    inviteOnly: opts.inviteOnly,
    setupCode: opts.setupCode,
    inviteLimit: opts.inviteLimit,
    linkFetcher: opts.linkFetcher,
    rateLimit: opts.rateLimit ?? false,
    backupDir: opts.backupDir,
    push: opts.push,
    pushSender: opts.pushSender,
    securityHeaders: opts.securityHeaders,
    usage: opts.usage,
    oauth: opts.oauth,
  });
  const server = createServer(app);
  attachRealtime(server, hubOf(app), cfg);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  servers.push(server);
  return { app, port: (server.address() as AddressInfo).port };
}

export async function signup(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({ username, password: "senha-bem-longa" });
  const cookie = String(res.headers["set-cookie"][0]).split(";")[0];
  return { agent, cookie, id: res.body.user.id as number };
}

/**
 * Conecta e guarda os eventos que chegarem; `next()` espera o próximo.
 * Avisos de presença e de novo membro são ignorados, a menos que `presence: true`.
 */
export async function connect(
  port: number,
  headers: Record<string, string> = {},
  opts: { presence?: boolean } = {},
) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers });
  sockets.push(ws);
  const received: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (!opts.presence && (m.type === "presence.updated" || m.type === "member.joined" || m.type === "channels.changed" || m.type === "member.updated")) return;
    const w = waiters.shift();
    if (w) w(m);
    else received.push(m);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return {
    ws,
    received,
    next: (ms = 2000) =>
      new Promise<any>((resolve, reject) => {
        if (received.length) return resolve(received.shift());
        const t = setTimeout(() => reject(new Error("nenhum evento chegou no WebSocket")), ms);
        waiters.push((m) => {
          clearTimeout(t);
          resolve(m);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}

export function rejectedStatus(port: number, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers });
    sockets.push(ws);
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("open", () => reject(new Error("a conexão deveria ter sido recusada")));
    ws.once("error", () => {});
  });
}

/** Ana (dono), Beto (membro) e Carla (de fora) com o servidor "Os Parças". */
export async function scenario(opts: { offlineGraceMs?: number; ringMs?: number; linkFetcher?: (url: string) => Promise<any>; rateLimit?: boolean; backupDir?: string; push?: any; pushSender?: any; usage?: any; mediaPool?: MediaPool; makeRoomService?: RoomServiceFactory } = {}) {
  const { app, port } = await start(opts);
  const ana = await signup(app, "ana");
  const beto = await signup(app, "beto");
  const carla = await signup(app, "carla");
  const server = (await ana.agent.post("/api/servers").send({ name: "Os Parças" })).body.server;
  const { code } = (await ana.agent.post(`/api/servers/${server.id}/invites`)).body;
  await beto.agent.post(`/api/invites/${code}/join`);
  const channelId = server.channels[0].id as number;
  // Convites valem uma vez: devolvemos um convite NOVO, ainda não usado, para os testes que põem mais alguém no servidor
  const spare = (await ana.agent.post(`/api/servers/${server.id}/invites`)).body.code as string;
  return { app, port, ana, beto, carla, server, channelId, code: spare };
}

/** Espera `ms` (para provar que algo NÃO aconteceu). */
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
