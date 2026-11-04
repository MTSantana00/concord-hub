import express, { Router } from "express";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { MAX_IMAGE_BYTES, imagePath, removeImage, saveImage, sniffImage } from "../images.js";
import { standing } from "../roles.js";
import { cleanLine } from "../profiles.js";

const MAX_NAME = 50;

/** Nome e ícone do servidor. Todo membro vê; só o dono muda. */
export function serverProfileRouter(db: Db, cfg: AuthConfig, hub: Hub, imagesDir: string) {
  const router = Router();
  router.use(requireAuth(cfg));
  const rawImage = express.raw({ type: "image/*", limit: MAX_IMAGE_BYTES });

  const current = (serverId: number) => {
    const r = db.prepare("SELECT id, name, icon_version FROM servers WHERE id = ?").get(serverId) as { id: number; name: string; icon_version: number };
    return { id: r.id, name: r.name, iconVersion: r.icon_version };
  };
  const announce = (serverId: number) => {
    const s = current(serverId);
    hub.publishToServer(serverId, { type: "server.updated", serverId, name: s.name, iconVersion: s.iconVersion });
  };

  /** Responde 404 (não é membro) ou 403 (não é o dono) e devolve false; senão true. */
  function ownerOnly(userId: number, serverId: number, res: express.Response): boolean {
    const me = Number.isInteger(serverId) ? standing(db, serverId, userId) : null;
    if (!me) {
      res.status(404).json({ error: "Servidor não encontrado" });
      return false;
    }
    if (!me.isOwner) {
      res.status(403).json({ error: "Só o dono do servidor pode mudar o nome e o ícone" });
      return false;
    }
    return true;
  }

  router.patch("/:id", (req, res) => {
    const serverId = Number(req.params.id);
    if (!ownerOnly(res.locals.userId as number, serverId, res)) return;
    const name = typeof req.body?.name === "string" ? cleanLine(req.body.name) : "";
    if (name.length < 1 || name.length > MAX_NAME) {
      res.status(400).json({ error: `O nome do servidor deve ter de 1 a ${MAX_NAME} caracteres` });
      return;
    }
    db.prepare("UPDATE servers SET name = ? WHERE id = ?").run(name, serverId);
    announce(serverId);
    res.json({ server: current(serverId) });
  });

  router.put("/:id/icon", rawImage, async (req, res) => {
    const serverId = Number(req.params.id);
    if (!ownerOnly(res.locals.userId as number, serverId, res)) return;
    const mime = sniffImage(req.body);
    if (!mime) {
      res.status(415).json({ error: "Envie uma imagem PNG, JPEG ou WebP de até 256 KB" });
      return;
    }
    await saveImage(imagesDir, "icon", serverId, req.body as Buffer);
    db.prepare("UPDATE servers SET icon_version = icon_version + 1, icon_mime = ? WHERE id = ?").run(mime, serverId);
    announce(serverId);
    res.json({ server: current(serverId) });
  });

  router.delete("/:id/icon", async (req, res) => {
    const serverId = Number(req.params.id);
    if (!ownerOnly(res.locals.userId as number, serverId, res)) return;
    db.prepare("UPDATE servers SET icon_version = 0, icon_mime = NULL WHERE id = ?").run(serverId);
    await removeImage(imagesDir, "icon", serverId);
    announce(serverId);
    res.json({ server: current(serverId) });
  });

  router.get("/:id/icon", (req, res) => {
    const serverId = Number(req.params.id);
    const me = Number.isInteger(serverId) ? standing(db, serverId, res.locals.userId as number) : null;
    const row = me
      ? (db.prepare("SELECT icon_mime FROM servers WHERE id = ? AND icon_version > 0").get(serverId) as { icon_mime: string } | undefined)
      : undefined;
    if (!row) {
      res.status(404).json({ error: "Ícone não encontrado" });
      return;
    }
    res.type(row.icon_mime);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Cache-Control", "private, max-age=86400");
    res.sendFile(imagePath(imagesDir, "icon", serverId), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Ícone não encontrado" });
    });
  });

  return router;
}
