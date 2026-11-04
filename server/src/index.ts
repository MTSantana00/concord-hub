import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, hubOf, meterOf } from "./app.js";
import { startBackups } from "./backup.js";
import { buildProviders } from "./oauth.js";
import { smtpMailerFromEnv } from "./mail.js";
import { openDb } from "./db.js";
import { connectSources, loadMediaConfig } from "./mediaConfig.js";
import { MediaPool } from "./mediaPool.js";
import { attachRealtime } from "./realtime.js";

// SERVER_PORT (e não PORT) para não colidir com a porta do Vite no dev
const port = Number(process.env.SERVER_PORT ?? 3001);
const isProduction = process.env.NODE_ENV === "production";

const jwtSecret = process.env.JWT_SECRET ?? (isProduction ? undefined : "segredo-so-para-dev");
if (!jwtSecret) {
  console.error("JWT_SECRET é obrigatório em produção.");
  process.exit(1);
}

const dbPath = process.env.DATABASE_PATH ?? "data/concord.db";
mkdirSync(dirname(dbPath), { recursive: true });

const audioDir = process.env.AUDIO_DIR ?? "data/audio";
mkdirSync(audioDir, { recursive: true });
const imagesDir = process.env.IMAGES_DIR ?? "data/images";
mkdirSync(imagesDir, { recursive: true });

const backupDir = process.env.BACKUP_DIR ?? "data/backups";
mkdirSync(backupDir, { recursive: true });
// Atrás do Caddy o IP real vem do cabeçalho; sem proxy (dev), não se confia nele
const trustProxy = Number(process.env.TRUST_PROXY ?? (isProduction ? 1 : 0));

// Notificações com o app fechado (opcional): gere as chaves uma vez com  npm run push-keys -w server
const push =
  process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject: process.env.VAPID_SUBJECT ?? "mailto:admin@example.com" }
    : null;

// Servidores de mídia (LiveKit): a reserva é obrigatória em produção; a principal (própria) é opcional
let mediaCfg: ReturnType<typeof loadMediaConfig>;
try {
  mediaCfg = loadMediaConfig(process.env, isProduction);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const mediaPool = new MediaPool(mediaCfg);

// Em produção o acesso é SÓ por convite, a menos que se diga o contrário (INVITE_ONLY=false)
const inviteOnly = isProduction ? process.env.INVITE_ONLY !== "false" : process.env.INVITE_ONLY === "true";
const inviteLimit = Number(process.env.INVITE_LIMIT ?? 10);
const setupCode = process.env.OWNER_SETUP_CODE || undefined;
if (setupCode && setupCode.length < 12) {
  console.error("OWNER_SETUP_CODE precisa ter pelo menos 12 caracteres.");
  process.exit(1);
}
// client/dist fica dois níveis acima, tanto em src/ (dev) quanto em dist/ (produção)
const clientDir = process.env.CLIENT_DIR ?? resolve(fileURLToPath(new URL("../../client/dist", import.meta.url)));

if (isProduction && jwtSecret.length < 32) console.warn("AVISO: JWT_SECRET tem menos de 32 caracteres; troque por um segredo longo e aleatório.");

// Em produção a página só pode falar com o próprio servidor e com os servidores de mídia
const securityHeaders = isProduction ? { connect: connectSources([mediaCfg.primary?.url, mediaCfg.fallback.url].filter((u): u is string => !!u)) } : undefined;

const authConfig = { jwtSecret, secureCookies: isProduction };
const db = openDb(dbPath);
const app = createApp({ db, backupDir, trustProxy, push, securityHeaders, oauth: buildProviders(process.env), mailer: smtpMailerFromEnv(process.env), usage: { dataDir: dirname(dbPath), minutesLimit: Number(process.env.LIVEKIT_MINUTES_LIMIT ?? 5000), gbLimit: Number(process.env.LIVEKIT_GB_LIMIT ?? 50) }, audioDir, imagesDir, mediaPool, inviteOnly, inviteLimit, setupCode, clientDir, ...authConfig });
const server = app.listen(port, () => {
  console.log(`Servidor ouvindo em http://localhost:${port}`);
});
attachRealtime(server, hubOf(app), authConfig);
startBackups(db, backupDir);
meterOf(app).start();
if (mediaCfg.primary) mediaPool.start(); // verifica a saúde do LiveKit próprio a cada 30 s
