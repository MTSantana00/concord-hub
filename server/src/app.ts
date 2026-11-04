import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import { requireAuth, type AuthConfig } from "./auth.js";
import { UsageMeter, type MeterOptions } from "./usage.js";
import { PushService, type PushConfig, type Sender } from "./push.js";
import { LIMITS, limiter } from "./rateLimit.js";
import { uploadGate } from "./uploadGate.js";
import { oauthRouter } from "./routes/oauth.js";
import type { Providers } from "./oauth.js";
import { pushRouter } from "./routes/push.js";
import { adminRouter } from "./routes/admin.js";
import type { Db } from "./db.js";
import { Hub } from "./hub.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_INVITE_LIMIT } from "./joining.js";
import { parseTarget, previewFor, type Preview } from "./linkPreview.js";
import { audioRouter } from "./routes/audio.js";
import { dmsRouter } from "./routes/dms.js";
import { authRouter } from "./routes/auth.js";
import { emailRouter } from "./routes/email.js";
import { deleteAccountRouter } from "./routes/deleteAccount.js";
import { MailService, type Mailer } from "./mail.js";
import { invitesRouter } from "./routes/invites.js";
import { messagesRouter } from "./routes/messages.js";
import { pollsRouter } from "./routes/polls.js";
import { moderationRouter } from "./routes/moderation.js";
import { profileRouter } from "./routes/profile.js";
import { richMessagesRouter } from "./routes/richMessages.js";
import { rolesRouter } from "./routes/roles.js";
import { unreadRouter } from "./routes/unread.js";
import { serverInvitesRouter } from "./routes/serverInvites.js";
import { serverProfileRouter } from "./routes/serverProfile.js";
import { serversRouter } from "./routes/servers.js";
import { MediaPool } from "./mediaPool.js";
import { voiceTokenRouter, type RoomServiceFactory } from "./routes/voiceToken.js";

export interface AppDeps extends AuthConfig {
  db: Db;
  /** Carência antes de anunciar alguém como offline (padrão no Hub). Os testes usam 0. */
  offlineGraceMs?: number;
  /** Quanto a chamada toca antes de virar "perdida" (padrão 30 s; os testes encurtam). */
  ringMs?: number;
  /** Pasta dos arquivos de áudio. Sem ela (testes), usa uma pasta temporária nova. */
  audioDir?: string;
  /** Pasta das fotos de perfil e ícones de servidor. Sem ela (testes), usa uma pasta temporária nova. */
  imagesDir?: string;
  /** Servidores de mídia (voz/vídeo): principal opcional + reserva. Sem ele, usa as chaves de desenvolvimento do `livekit-server --dev`. */
  mediaPool?: MediaPool;
  /** Como derrubar alguém da sala de mídia (os testes trocam por um falso). */
  makeRoomService?: RoomServiceFactory;
  /** Cadastro só com código de convite válido (para servidor aberto na internet). */
  inviteOnly?: boolean;
  /** Quantos convites cada pessoa pode ter no total (padrão 10). */
  inviteLimit?: number;
  /** Código secreto que permite criar a PRIMEIRA conta (o dono) num servidor fechado e vazio. */
  setupCode?: string;
  /** Pasta do cliente já compilado (client/dist). Se existir, o servidor a entrega junto com a API. */
  clientDir?: string;
  /** Busca a prévia de um link (os testes trocam por uma versão sem rede). */
  linkFetcher?: (url: string) => Promise<Preview | null>;
  /** Limites anti-spam (padrão: ligados; os testes desligam). */
  rateLimit?: boolean;
  /** Quantos proxies (ex.: Caddy) ficam na frente: o IP real vem do cabeçalho X-Forwarded-For. 0 = nenhum. */
  trustProxy?: number;
  /** Pasta dos backups automáticos (só para listar na tela da administradora). */
  backupDir?: string;
  /** Ligue em produção: política de conteúdo (CSP) e demais cabeçalhos. `connect` = servidores de mídia que a página pode acessar (ex.: wss://...livekit.cloud). */
  securityHeaders?: { connect: string[] };
  /** Conferência dos limites (voz e VM). */
  usage?: MeterOptions;
  /** Entrar com Google/GitHub (só liga o que tiver credenciais). */
  oauth?: { providers: Providers; publicUrl: string | null };
  /** Chaves das notificações com o app fechado; sem elas o recurso fica desligado. */
  push?: PushConfig | null;
  /** Envio de notificação (os testes trocam por um falso). */
  pushSender?: Sender;
  /** Envio de e-mail (SMTP). Sem ele, não há e-mail no cadastro nem "esqueci a senha": o app funciona como antes. */
  mailer?: Mailer | null;
}

const devMediaPool = () => new MediaPool({ primary: null, fallback: { url: "ws://localhost:7880", apiKey: "devkey", apiSecret: "secret" } }, async () => true);

export function createApp({ db, offlineGraceMs, ringMs, audioDir, imagesDir, mediaPool = devMediaPool(), makeRoomService, inviteOnly, inviteLimit = DEFAULT_INVITE_LIMIT, setupCode, clientDir, linkFetcher, rateLimit = true, trustProxy = 0, backupDir, push = null, pushSender, securityHeaders, usage, oauth, mailer = null, ...baseAuth }: AppDeps) {
  const audioFolder = audioDir ?? mkdtempSync(join(tmpdir(), "concord-audio-"));
  const imagesFolder = imagesDir ?? mkdtempSync(join(tmpdir(), "concord-images-"));
  const app = express();
  if (trustProxy > 0) app.set("trust proxy", trustProxy);
  const hub = new Hub(db, offlineGraceMs, ringMs);
  const authConfig: AuthConfig = { ...baseAuth, tokenVersion: (id) => hub.tokenVersion(id) };
  app.locals.hub = hub;
  const pushService = new PushService(db, hub, push, pushSender ?? undefined);
  hub.push = pushService;
  hub.media = mediaPool;
  const meter = new UsageMeter(db, hub, pushService, { backupDir, ...usage });
  app.locals.meter = meter;
  // A principal caiu ou voltou: avisa a administradora (chave única por ocorrência, para o mesmo dia poder repetir)
  mediaPool.onChange((healthy) => {
    const key = `voz-propria:${new Date().toISOString()}:${healthy ? "up" : "down"}`;
    if (healthy) meter.notify(key, "aviso", "Servidor de voz próprio voltou", "O LiveKit próprio respondeu de novo. As próximas salas de voz voltam a usá-lo; quem já está numa sala na reserva continua nela até sair.");
    else meter.notify(key, "critico", "Servidor de voz próprio fora do ar", "A voz está usando a reserva (LiveKit Cloud), que tem limite de 5.000 minutos e 50 GB por mês. Quem já estava numa sala do servidor próprio pode cair; as salas novas já nascem na reserva.");
  });

  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" });
    if (securityHeaders) {
      res.set({
        // A página só carrega o que é dela; fala com o próprio servidor e com o servidor de mídia; ninguém a coloca em moldura
        "Content-Security-Policy": [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "media-src 'self' blob:",
          `connect-src ${["'self'", ...securityHeaders.connect].join(" ")}`,
          "worker-src 'self' blob:",
          "manifest-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join("; "),
        "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Strict-Transport-Security": "max-age=15552000",
      });
    }
    next();
  });
  app.use(express.json({ limit: "10kb" }));
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Limites anti-spam: contam por pessoa (mensagens, anexos, reações) ou por endereço (entrar, criar conta, convites)
  const auth = requireAuth(authConfig);
  app.post("/api/auth/login", limiter(LIMITS.login, rateLimit));
  app.post("/api/auth/register", limiter(LIMITS.register, rateLimit));
  app.post("/api/auth/delete-account", limiter(LIMITS.reset, rateLimit));
  app.post("/api/auth/forgot", limiter(LIMITS.forgot, rateLimit));
  app.post("/api/auth/reset", limiter(LIMITS.reset, rateLimit));
  app.post("/api/auth/email/send-code", auth, limiter(LIMITS.emailCode, rateLimit));
  app.post("/api/auth/email/verify", auth, limiter(LIMITS.reset, rateLimit));
  app.post("/api/invites/:code/join", limiter(LIMITS.joinInvite, rateLimit));
  app.post(["/api/channels/:id/messages", "/api/dms/:id/messages", "/api/channels/:id/polls"], auth, limiter(LIMITS.text, rateLimit));
  app.post(["/api/channels/:id/attachments", "/api/dms/:id/attachments", "/api/channels/:id/audio", "/api/dms/:id/audio"], auth, limiter(LIMITS.uploads, rateLimit), uploadGate());
  app.post(["/api/channels/:id/messages/:messageId/reactions", "/api/dms/:id/messages/:messageId/reactions", "/api/channels/:id/messages/:messageId/vote"], auth, limiter(LIMITS.reactions, rateLimit));

  app.use("/api/push", pushRouter(authConfig, pushService));
  app.use("/api/admin", adminRouter(db, authConfig, backupDir ?? join(tmpdir(), "concord-no-backups"), meter));
  app.use("/api/auth/oauth", limiter(LIMITS.oauth, rateLimit), oauthRouter(db, authConfig, hub, { providers: oauth?.providers ?? {}, publicUrl: oauth?.publicUrl ?? null, inviteOnly: !!inviteOnly, setupCode }));
  const mail = new MailService(db, mailer, baseAuth.jwtSecret, oauth?.publicUrl ?? null);
  app.use("/api/auth", emailRouter(db, authConfig, mail));
  app.use("/api/auth", deleteAccountRouter(db, authConfig, hub, audioFolder, imagesFolder, mail));
  app.use("/api/auth", authRouter(db, authConfig, hub, inviteOnly, setupCode, mail));
  app.use("/api/servers", serversRouter(db, authConfig, hub));
  app.use("/api/servers", rolesRouter(db, authConfig, hub));
  app.use("/api/servers", serverProfileRouter(db, authConfig, hub, imagesFolder));
  app.use("/api/servers", serverInvitesRouter(db, authConfig, inviteLimit));
  app.use("/api/servers", moderationRouter(db, authConfig, hub));
  app.use("/api/invites", invitesRouter(db, authConfig, hub));
  app.use("/api/channels", messagesRouter(db, authConfig, hub, audioFolder));
  app.use("/api/channels", pollsRouter(db, authConfig, hub));
  app.use("/api/dms", dmsRouter(db, authConfig, hub, audioFolder));
  app.use("/api/voice", voiceTokenRouter(db, authConfig, hub, mediaPool, makeRoomService));
  app.use("/api/profile", profileRouter(db, authConfig, hub, imagesFolder));
  app.get("/api/link-preview", requireAuth(authConfig), async (req, res) => {
    const raw = typeof req.query.url === "string" ? req.query.url : "";
    if (raw.length > 2000 || !parseTarget(raw)) {
      res.status(400).json({ error: "Link inválido" });
      return;
    }
    res.json({ preview: await previewFor(db, raw, linkFetcher) });
  });
  app.use("/api", unreadRouter(db, authConfig, hub));
  app.use("/api", richMessagesRouter(db, authConfig, hub, audioFolder));
  app.use("/api", audioRouter(db, authConfig, hub, audioFolder));

  // Cliente compilado: arquivos estáticos e, para qualquer outro endereço (ex.: /convite/abc), o index.html
  if (clientDir && existsSync(resolve(clientDir, "index.html"))) {
    const dir = resolve(clientDir);
    app.use(
      express.static(dir, {
        index: false,
        maxAge: "1h",
        // O service worker e o manifesto precisam ser relidos sempre, senão uma versão nova demora a valer
        setHeaders: (res, path) => {
          if (/(sw.js|manifest.webmanifest)$/.test(path)) res.set("Cache-Control", "no-cache");
          // Arquivos de /assets/ têm o hash do conteúdo no nome: nunca mudam, então ficam em cache por um ano
          else if (/[\\/]assets[\\/]/.test(path)) res.set("Cache-Control", "public, max-age=31536000, immutable");
        },
      }),
    );
    app.get(/^\/(?!api\/|ws$).*/, (_req, res) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(resolve(dir, "index.html"));
    });
  }

  return app;
}

/** O monitor de limites do app (o index.ts liga os temporizadores). */
export function meterOf(app: express.Express): UsageMeter {
  return app.locals.meter as UsageMeter;
}

/** O hub de tempo real do app, para ligar ao servidor HTTP (ver realtime.ts). */
export function hubOf(app: express.Express): Hub {
  return app.locals.hub as Hub;
}
