import { Router } from "express";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { PushService } from "../push.js";

/** Serviços de push dos navegadores (Chrome/Edge/Opera, Firefox, Safari, Windows). Qualquer outro endereço é recusado. */
export const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9-]+\.)?push\.apple\.com|([a-z0-9-]+\.)?notify\.windows\.com)$/;

const b64url = /^[A-Za-z0-9_-]{8,200}={0,2}$/;

/** Assinatura de notificações com o app fechado. Sem chaves configuradas no servidor, o recurso fica desligado. */
export function pushRouter(cfg: AuthConfig, push: PushService) {
  const router = Router();
  router.use(requireAuth(cfg));

  router.get("/key", (_req, res) => {
    res.json({ publicKey: push.publicKey });
  });

  router.post("/subscribe", (req, res) => {
    if (!push.publicKey) {
      res.status(503).json({ error: "Notificações com o app fechado não estão ligadas neste servidor" });
      return;
    }
    const { endpoint, keys } = req.body ?? {};
    let ok = typeof endpoint === "string" && endpoint.length <= 2048 && !!keys && b64url.test(keys.p256dh ?? "") && b64url.test(keys.auth ?? "");
    if (ok) {
      try {
        const u = new URL(endpoint);
        ok = u.protocol === "https:" && u.port === "" && !u.username && !u.password && PUSH_HOSTS.test(u.hostname);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      res.status(400).json({ error: "Assinatura inválida" });
      return;
    }
    push.subscribe(res.locals.userId as number, { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
    res.status(204).end();
  });

  router.delete("/subscribe", (req, res) => {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== "string") {
      res.status(400).json({ error: "Informe o endereço da assinatura" });
      return;
    }
    push.unsubscribe(res.locals.userId as number, endpoint);
    res.status(204).end();
  });

  return router;
}
