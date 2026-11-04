import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import { requireAuth, type AuthConfig } from "../auth.js";
import { copyDatabase, listBackups, stamp, verifyCopy } from "../backup.js";
import type { Db } from "../db.js";
import type { UsageMeter } from "../usage.js";

/** Só a administradora da plataforma (a primeira conta): backups do banco. */
export function adminRouter(db: Db, cfg: AuthConfig, backupDir: string, meter: UsageMeter) {
  const router = Router();
  router.use(requireAuth(cfg));
  router.use((_req, res, next) => {
    const row = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(res.locals.userId as number) as { is_admin: number } | undefined;
    if (!row?.is_admin) {
      res.status(403).json({ error: "Só a administradora da plataforma pode fazer isso" });
      return;
    }
    next();
  });

  /** Uso do plano de voz no mês, saúde da VM e avisos de limite. */
  router.get("/usage", (_req, res) => {
    res.json(meter.status());
  });

  /** Marca os avisos como lidos (todos, ou só o id informado). */
  router.post("/alerts/ack", (req, res) => {
    const id = req.body?.id;
    if (id !== undefined && !Number.isInteger(id)) {
      res.status(400).json({ error: "Aviso inválido" });
      return;
    }
    meter.ack(id);
    res.status(204).end();
  });

  /** Backups automáticos guardados na VM. */
  router.get("/backups", (_req, res) => {
    res.json({ backups: listBackups(backupDir) });
  });

  /** Um backup novo do banco, para guardar fora da VM. */
  router.get("/backup", (_req, res) => {
    const dir = mkdtempSync(join(tmpdir(), "concord-dl-"));
    const file = join(dir, "backup.db");
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    try {
      copyDatabase(db, file);
      if (verifyCopy(file)) throw new Error("cópia inválida");
    } catch {
      cleanup();
      res.status(500).json({ error: "Não foi possível gerar o backup" });
      return;
    }
    res.set("Cache-Control", "no-store");
    res.download(file, `concord-${stamp(new Date())}.db`, cleanup);
  });

  return router;
}
