import { readFileSync, statfsSync } from "node:fs";
import type { Db } from "./db.js";
import type { Hub } from "./hub.js";
import { listBackups } from "./backup.js";
import type { PushService } from "./push.js";

/** Limites do plano gratuito do LiveKit Cloud (por mês). 0 desliga a conferência (ex.: servidor de mídia próprio). */
export const DEFAULT_MINUTES_LIMIT = 5000;
export const DEFAULT_GB_LIMIT = 50;
/** Quando avisar, em % do limite. */
export const THRESHOLDS = [70, 90, 100] as const;
/** Um áudio (Opus ~32 kbps) gasta cerca de 0,24 MB por minuto para cada pessoa que o recebe. */
const AUDIO_MB_PER_MIN = 0.24;
const MAX_BACKUP_AGE_MS = 36 * 60 * 60 * 1000;

export interface VmReading {
  memAvailableMb: number;
  memTotalMb: number;
  swapUsedMb: number;
  swapTotalMb: number;
  diskUsedPct: number;
  containerMemMb: number | null;
  containerLimitMb: number | null;
}

const mb = (bytes: number) => Math.round(bytes / 1048576);

/** Lê a memória e o disco da máquina (a VM, vista de dentro do container) e o consumo do próprio container. */
export function readVm(dataDir: string): VmReading {
  const info = new Map<string, number>();
  try {
    for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
      const m = /^(\w+):\s+(\d+) kB/.exec(line);
      if (m) info.set(m[1], Number(m[2]) * 1024);
    }
  } catch {
    // fora do Linux (desenvolvimento no Windows): sem leitura
  }
  let diskUsedPct = 0;
  try {
    const s = statfsSync(dataDir);
    diskUsedPct = s.blocks > 0 ? Math.round((1 - s.bavail / s.blocks) * 100) : 0;
  } catch {
    // sem leitura
  }
  const cg = (file: string): number | null => {
    try {
      const raw = readFileSync(file, "utf8").trim();
      return raw === "max" ? null : Number(raw);
    } catch {
      return null;
    }
  };
  const used = cg("/sys/fs/cgroup/memory.current");
  const limit = cg("/sys/fs/cgroup/memory.max");
  return {
    memAvailableMb: mb(info.get("MemAvailable") ?? 0),
    memTotalMb: mb(info.get("MemTotal") ?? 0),
    swapUsedMb: mb((info.get("SwapTotal") ?? 0) - (info.get("SwapFree") ?? 0)),
    swapTotalMb: mb(info.get("SwapTotal") ?? 0),
    diskUsedPct,
    containerMemMb: used === null ? null : mb(used),
    containerLimitMb: limit === null ? null : mb(limit),
  };
}

export interface Alert {
  id: number;
  level: "aviso" | "critico";
  title: string;
  message: string;
  createdAt: string;
  acked: boolean;
}

export interface MeterOptions {
  minutesLimit?: number;
  gbLimit?: number;
  backupDir?: string;
  dataDir?: string;
  read?: () => VmReading;
  now?: () => Date;
}

const month = (d: Date) => d.toISOString().slice(0, 7);
const day = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

/**
 * Conta o uso do plano gratuito de voz (minutos de participante e tráfego estimado) e confere a saúde da VM.
 * Quando algo chega perto do limite, grava um aviso e manda notificação à administradora (no app e com o app fechado).
 */
export class UsageMeter {
  private minutesLimit: number;
  private gbLimit: number;
  private now: () => Date;
  private read: () => VmReading;

  constructor(
    private db: Db,
    private hub: Hub,
    private push: PushService | null,
    private opts: MeterOptions = {},
  ) {
    this.minutesLimit = opts.minutesLimit ?? DEFAULT_MINUTES_LIMIT;
    this.gbLimit = opts.gbLimit ?? DEFAULT_GB_LIMIT;
    this.now = opts.now ?? (() => new Date());
    this.read = opts.read ?? (() => readVm(opts.dataDir ?? "."));
  }

  private get(kind: string, m = month(this.now())): number {
    return (this.db.prepare("SELECT value FROM usage_monthly WHERE month = ? AND kind = ?").get(m, kind) as { value: number } | undefined)?.value ?? 0;
  }

  /** Soma ao mês e confere se passou de algum limite de aviso. */
  record(minutes: number, gb: number) {
    const m = month(this.now());
    const add = this.db.prepare(
      "INSERT INTO usage_monthly (month, kind, value) VALUES (?, ?, ?) ON CONFLICT(month, kind) DO UPDATE SET value = value + excluded.value",
    );
    if (minutes) add.run(m, "voice_minutes", minutes);
    if (gb) add.run(m, "voice_gb", gb);
    this.checkVoice();
  }

  /**
   * Passou um minuto: cada pessoa conectada à voz (salas e chamadas) gasta um minuto. `rooms` = quantas pessoas há em cada sala.
   * Com servidor próprio configurado, só as salas que nasceram na reserva (LiveKit Cloud) gastam o plano gratuito.
   */
  tickVoice(rooms: { room: string; size: number }[] = [...this.hub.voice.roomSizes(), ...this.hub.calls.activeCallSizes()]) {
    const media = this.hub.media;
    const counted = media?.hasPrimary ? rooms.filter((r) => media.serverOf(r.room) === "fallback") : rooms;
    const sizes = counted.map((r) => r.size);
    const minutes = sizes.reduce((s, n) => s + n, 0);
    if (minutes === 0) return;
    const gb = sizes.reduce((s, n) => s + n * Math.max(0, n - 1) * AUDIO_MB_PER_MIN, 0) / 1024;
    this.record(minutes, gb);
  }

  checkVoice() {
    const now = this.now();
    const m = month(now);
    const checks: [string, number, number, string, string][] = [
      ["voz-min", this.get("voice_minutes"), this.minutesLimit, "minutos de voz", "minutos de participante"],
      ["voz-gb", this.get("voice_gb"), this.gbLimit, "tráfego de voz (estimado)", "GB"],
    ];
    for (const [key, used, limit, name, unit] of checks) {
      if (limit <= 0) continue;
      const pct = (used / limit) * 100;
      for (const t of THRESHOLDS) {
        if (pct < t) continue;
        const gone = t >= 100;
        this.alert(
          `${key}:${m}:${t}`,
          t >= 90 ? "critico" : "aviso",
          gone ? `Limite de voz atingido (${name})` : `Voz: ${t}% do limite gratuito (${name})`,
          gone
            ? `Os ${fmt(limit)} ${unit} gratuitos deste mês acabaram. Novas entradas em salas de voz vão falhar até o dia 1º do mês que vem. O chat de texto não é afetado.`
            : `${fmt(used)} de ${fmt(limit)} ${unit} gratuitos usados neste mês (${Math.round(pct)}%). Quando acabar, ninguém entra em sala de voz até o dia 1º. Considere reduzir o tempo em chamada.`,
        );
      }
    }
  }

  /** Confere a VM: memória, troca (swap), disco, memória do container e atraso do backup. */
  checkVm() {
    const now = this.now();
    const d = day(now);
    const v = this.read();
    if (v.memTotalMb > 0) {
      const frac = v.memAvailableMb / v.memTotalMb;
      if (frac < 0.06) this.alert(`vm-mem:${d}:critico`, "critico", "Memória da VM quase no fim", `Só ${v.memAvailableMb} MB livres de ${v.memTotalMb} MB. O Concord e o app do casal podem travar ou reiniciar.`);
      else if (frac < 0.12) this.alert(`vm-mem:${d}:aviso`, "aviso", "Memória da VM baixa", `Só ${v.memAvailableMb} MB livres de ${v.memTotalMb} MB. Se continuar assim, a VM vai ficar lenta.`);
    }
    if (v.swapTotalMb > 0 && v.swapUsedMb / v.swapTotalMb >= 0.85) {
      this.alert(`vm-swap:${d}`, "aviso", "Memória de troca (swap) quase cheia", `${v.swapUsedMb} MB de ${v.swapTotalMb} MB em uso: a VM está sem memória de verdade e pode travar.`);
    }
    if (v.diskUsedPct >= 90) this.alert(`vm-disco:${d}:critico`, "critico", "Disco da VM quase cheio", `${v.diskUsedPct}% usado. Apague arquivos antigos ou os backups, antes que o chat pare de gravar.`);
    else if (v.diskUsedPct >= 80) this.alert(`vm-disco:${d}:aviso`, "aviso", "Disco da VM enchendo", `${v.diskUsedPct}% usado.`);
    if (v.containerMemMb !== null && v.containerLimitMb) {
      const frac = v.containerMemMb / v.containerLimitMb;
      if (frac >= 0.95) this.alert(`concord-mem:${d}:critico`, "critico", "Concord no limite de memória", `Usando ${v.containerMemMb} de ${v.containerLimitMb} MB. Ele pode reiniciar a qualquer momento (derrubando todo mundo por segundos).`);
      else if (frac >= 0.85) this.alert(`concord-mem:${d}:aviso`, "aviso", "Concord perto do limite de memória", `Usando ${v.containerMemMb} de ${v.containerLimitMb} MB.`);
    }
    if (this.opts.backupDir) {
      const last = listBackups(this.opts.backupDir)[0];
      if (!last || now.getTime() - new Date(last.createdAt).getTime() > MAX_BACKUP_AGE_MS) {
        this.alert(`backup:${d}`, "aviso", "Backup automático atrasado", "Faz mais de 36 horas que não sai um backup do banco. Baixe um agora em Minha conta → Administração.");
      }
    }
  }

  /** Grava o aviso (uma vez por chave) e, se era novo, notifica as administradoras. */
  notify(key: string, level: Alert["level"], title: string, message: string) {
    this.alert(key, level, title, message);
  }

  private alert(key: string, level: Alert["level"], title: string, message: string) {
    const r = this.db.prepare("INSERT OR IGNORE INTO admin_alerts (key, level, title, message) VALUES (?, ?, ?, ?)").run(key, level, title, message);
    if (r.changes === 0) return;
    const alert = this.alerts(1)[0];
    const admins = (this.db.prepare("SELECT id FROM users WHERE is_admin = 1").all() as { id: number }[]).map((a) => a.id);
    this.hub.publishToUsers(admins, { type: "admin.alert", alert });
    this.push?.notifyUsers(admins, { title: `⚠ ${title}`, body: message.length > 140 ? `${message.slice(0, 139)}…` : message, tag: "admin-alert" });
  }

  alerts(limit = 20): Alert[] {
    return (
      this.db
        .prepare("SELECT id, level, title, message, created_at, acked_at FROM admin_alerts ORDER BY id DESC LIMIT ?")
        .all(limit) as { id: number; level: Alert["level"]; title: string; message: string; created_at: string; acked_at: string | null }[]
    ).map((a) => ({ id: a.id, level: a.level, title: a.title, message: a.message, createdAt: a.created_at, acked: a.acked_at !== null }));
  }

  ack(id?: number) {
    if (id === undefined) this.db.prepare("UPDATE admin_alerts SET acked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE acked_at IS NULL").run();
    else this.db.prepare("UPDATE admin_alerts SET acked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND acked_at IS NULL").run(id);
  }

  /** O que a tela da administradora mostra. */
  status() {
    return {
      month: month(this.now()),
      voice: {
        minutes: Math.round(this.get("voice_minutes")),
        minutesLimit: this.minutesLimit,
        gb: Math.round(this.get("voice_gb") * 10) / 10,
        gbLimit: this.gbLimit,
      },
      vm: this.read(),
      alerts: this.alerts(),
    };
  }

  /** Liga as conferências: voz a cada minuto, VM a cada 10 min. Devolve a função que desliga. */
  start(): () => void {
    const voice = setInterval(() => this.tickVoice(), 60_000);
    const vm = setInterval(() => this.checkVm(), 10 * 60_000);
    const first = setTimeout(() => this.checkVm(), 30_000);
    voice.unref();
    vm.unref();
    first.unref();
    return () => {
      clearInterval(voice);
      clearInterval(vm);
      clearTimeout(first);
    };
  }
}
