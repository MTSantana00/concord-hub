import bcrypt from "bcryptjs";
import { Router } from "express";
import { COOKIE_NAME, cookieOptions, requireAuth, type AuthConfig } from "../auth.js";
import { removeAudioFile } from "../audioFiles.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import { removeImage } from "../images.js";
import { templates, type MailService } from "../mail.js";

const NO_PASSWORD = "!"; // conta criada pelo Google/GitHub não tem senha (ver routes/oauth.ts)

/**
 * Excluir a própria conta (LGPD, art. 18): apaga a pessoa e, em cascata, mensagens, conversas, membros, convites,
 * logins externos e assinaturas de notificação; depois remove da pasta os arquivos dela (foto, áudios e anexos).
 */
export function deleteAccountRouter(db: Db, cfg: AuthConfig, hub: Hub, mediaDir: string, imagesDir: string, mail: MailService | null) {
  const router = Router();

  router.post("/delete-account", requireAuth(cfg), async (req, res) => {
    const userId = res.locals.userId as number;
    const row = db.prepare("SELECT username, password_hash, is_admin, email FROM users WHERE id = ?").get(userId) as
      | { username: string; password_hash: string; is_admin: number; email: string | null }
      | undefined;
    if (!row) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    const { password, confirm } = req.body ?? {};
    if (confirm !== row.username) {
      res.status(400).json({ error: "Para confirmar, digite o seu nome de usuário exatamente como ele é." });
      return;
    }
    if (row.password_hash !== NO_PASSWORD && (typeof password !== "string" || !(await bcrypt.compare(password, row.password_hash)))) {
      res.status(403).json({ error: "A senha está errada." });
      return;
    }
    if (row.is_admin === 1) {
      res.status(403).json({ error: "A administradora da plataforma não pode excluir a conta por aqui." });
      return;
    }
    const owned = db.prepare("SELECT name FROM servers WHERE owner_id = ? ORDER BY name").all(userId) as { name: string }[];
    if (owned.length > 0) {
      res.status(409).json({ error: `Você é dona ou dono de: ${owned.map((s) => s.name).join(", ")}. Apague esses servidores antes de excluir a conta.` });
      return;
    }

    // o que precisa sair do disco e quem precisa saber, anotado antes de o banco esquecer
    const files = db.prepare("SELECT id FROM messages WHERE user_id = ? AND (audio_ms IS NOT NULL OR att_name IS NOT NULL)").all(userId) as { id: number }[];
    const servers = db.prepare("SELECT server_id FROM members WHERE user_id = ?").all(userId) as { server_id: number }[];

    hub.voice.leave(userId);
    hub.calls.hangupFor(userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    hub.dropUser(userId);
    for (const { server_id } of servers) hub.publishToServer(server_id, { type: "member.removed", serverId: server_id, userId, reason: "left" });

    await Promise.all([...files.map((f) => removeAudioFile(mediaDir, f.id)), removeImage(imagesDir, "avatar", userId)]);
    if (row.email && mail?.enabled) void mail.notify(row.email, templates.accountDeleted(row.username));

    const { maxAge: _maxAge, ...clearOptions } = cookieOptions(cfg);
    res.clearCookie(COOKIE_NAME, clearOptions);
    res.status(204).end();
  });

  return router;
}
