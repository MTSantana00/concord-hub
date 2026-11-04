import express, { Router } from "express";
import { requireAuth, type AuthConfig } from "../auth.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { MAX_IMAGE_BYTES, imagePath, removeImage, saveImage, sniffImage } from "../images.js";
import {
  MAX_ABOUT,
  MAX_DISPLAY_NAME,
  MAX_STATUS_TEXT,
  STATUS_KINDS,
  cleanLine,
  toProfile,
  type ProfileRow,
  type StatusKind,
} from "../profiles.js";

const PROFILE_SQL = "SELECT display_name, about, status_kind, status_text, avatar_version FROM users WHERE id = ?";

/**
 * Meu perfil: nome de exibição, "sobre mim", status e foto.
 * A foto de alguém só é vista por si mesmo e por quem divide um servidor com a pessoa.
 */
export function profileRouter(db: Db, cfg: AuthConfig, hub: Hub, imagesDir: string) {
  const router = Router();
  router.use(requireAuth(cfg));
  const rawImage = express.raw({ type: "image/*", limit: MAX_IMAGE_BYTES });

  const mine = (id: number) => toProfile(db.prepare(PROFILE_SQL).get(id) as unknown as ProfileRow);
  const announce = (userId: number) => hub.publishToPeers(userId, { type: "profile.updated", userId, profile: mine(userId) });

  router.get("/", (_req, res) => {
    res.json({ profile: mine(res.locals.userId as number) });
  });

  router.patch("/", (req, res) => {
    const userId = res.locals.userId as number;
    const body = req.body ?? {};
    const sets: string[] = [];
    const values: (string | null)[] = [];

    if (body.displayName !== undefined) {
      const name = typeof body.displayName === "string" ? cleanLine(body.displayName) : null;
      if (name === null || name.length > MAX_DISPLAY_NAME) {
        res.status(400).json({ error: `O nome deve ter até ${MAX_DISPLAY_NAME} caracteres` });
        return;
      }
      sets.push("display_name = ?");
      values.push(name === "" ? null : name); // vazio = volta a mostrar o usuário
    }
    if (body.about !== undefined) {
      const about = typeof body.about === "string" ? cleanLine(body.about) : null;
      if (about === null || about.length > MAX_ABOUT) {
        res.status(400).json({ error: `O "sobre mim" deve ter até ${MAX_ABOUT} caracteres` });
        return;
      }
      sets.push("about = ?");
      values.push(about);
    }
    if (body.statusKind !== undefined) {
      if (typeof body.statusKind !== "string" || !(STATUS_KINDS as readonly string[]).includes(body.statusKind)) {
        res.status(400).json({ error: "Status inválido" });
        return;
      }
      sets.push("status_kind = ?");
      values.push(body.statusKind as StatusKind);
    }
    if (body.statusText !== undefined) {
      const text = typeof body.statusText === "string" ? cleanLine(body.statusText) : null;
      if (text === null || text.length > MAX_STATUS_TEXT) {
        res.status(400).json({ error: `O texto do status deve ter até ${MAX_STATUS_TEXT} caracteres` });
        return;
      }
      sets.push("status_text = ?");
      values.push(text);
    }

    if (sets.length > 0) db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values, userId);
    announce(userId);
    res.json({ profile: mine(userId) });
  });

  router.put("/avatar", rawImage, async (req, res) => {
    const userId = res.locals.userId as number;
    const mime = sniffImage(req.body);
    if (!mime) {
      res.status(415).json({ error: "Envie uma imagem PNG, JPEG ou WebP de até 256 KB" });
      return;
    }
    await saveImage(imagesDir, "avatar", userId, req.body as Buffer);
    db.prepare("UPDATE users SET avatar_version = avatar_version + 1, avatar_mime = ? WHERE id = ?").run(mime, userId);
    announce(userId);
    res.json({ profile: mine(userId) });
  });

  router.delete("/avatar", async (_req, res) => {
    const userId = res.locals.userId as number;
    db.prepare("UPDATE users SET avatar_version = 0, avatar_mime = NULL WHERE id = ?").run(userId);
    await removeImage(imagesDir, "avatar", userId);
    announce(userId);
    res.json({ profile: mine(userId) });
  });

  /** GET /api/profile/avatar/:id — a foto de alguém que divide um servidor comigo (ou a minha). */
  router.get("/avatar/:id", (req, res) => {
    const me = res.locals.userId as number;
    const id = Number(req.params.id);
    const row = Number.isInteger(id)
      ? (db.prepare("SELECT avatar_mime FROM users WHERE id = ? AND avatar_version > 0").get(id) as { avatar_mime: string } | undefined)
      : undefined;
    const allowed =
      row &&
      (id === me ||
        db
          .prepare("SELECT 1 FROM members a JOIN members b ON b.server_id = a.server_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1")
          .get(me, id));
    if (!row || !allowed) {
      res.status(404).json({ error: "Foto não encontrada" });
      return;
    }
    res.type(row.avatar_mime);
    res.set("X-Content-Type-Options", "nosniff");
    // A página pede /avatar?v=<versão>; trocar a foto muda a versão, então dá para guardar por muito tempo
    res.set("Cache-Control", "private, max-age=86400");
    res.sendFile(imagePath(imagesDir, "avatar", id), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Foto não encontrada" });
    });
  });

  return router;
}
