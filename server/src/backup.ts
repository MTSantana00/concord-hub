import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
// getBuiltinModule porque o Vitest não resolve `import "node:sqlite"`
const sqlite = process.getBuiltinModule("node:sqlite");
import type { Db } from "./db.js";

export const KEEP_BACKUPS = 14;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const NAME = /^concord-\d{8}-\d{6}\.db$/;

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const stamp = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

/** Copia o banco com o próprio SQLite (consistente mesmo com o app em uso) para `file`. */
export function copyDatabase(db: Db, file: string) {
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}

/** Abre a cópia e confere que ela está íntegra; devolve a mensagem do problema, ou null se está tudo certo. */
export function verifyCopy(file: string): string | null {
  const copy = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const result = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    return result.integrity_check === "ok" ? null : result.integrity_check;
  } finally {
    copy.close();
  }
}

/** Backups existentes, do mais novo ao mais antigo. */
export function listBackups(dir: string): BackupInfo[] {
  try {
    return readdirSync(dir)
      .filter((n) => NAME.test(n))
      .map((name) => {
        const st = statSync(join(dir, name));
        return { name, size: st.size, createdAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

/** Cria um backup agora, confere e apaga os mais antigos além de `keep`. Devolve o nome, ou lança se a cópia não passou na conferência. */
export function createBackup(db: Db, dir: string, now = new Date(), keep = KEEP_BACKUPS): string {
  mkdirSync(resolve(dir), { recursive: true });
  const name = `concord-${stamp(now)}.db`;
  const file = resolve(dir, name);
  copyDatabase(db, file);
  const problem = verifyCopy(file);
  if (problem) {
    rmSync(file, { force: true });
    throw new Error(`O backup não passou na conferência: ${problem}`);
  }
  for (const old of listBackups(dir).slice(keep)) rmSync(join(dir, old.name), { force: true });
  return name;
}

/** Cria um backup se o último tiver mais de 24 h (ou não houver nenhum). Devolve o nome criado ou null. */
export function backupIfDue(db: Db, dir: string, now = new Date()): string | null {
  const last = listBackups(dir)[0];
  if (last && now.getTime() - new Date(last.createdAt).getTime() < MAX_AGE_MS) return null;
  return createBackup(db, dir, now);
}

/** Liga o backup automático: confere ao subir e a cada 6 h. Devolve a função que desliga. */
export function startBackups(db: Db, dir: string, log: (msg: string) => void = console.log): () => void {
  const run = () => {
    try {
      const name = backupIfDue(db, dir);
      if (name) log(`Backup automático criado: ${name}`);
    } catch (err) {
      console.error("Falha no backup automático:", err instanceof Error ? err.message : err);
    }
  };
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, CHECK_EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
