/** Como falar com um servidor de mídia (LiveKit). */
export interface MediaConfig {
  /** Endereço que o NAVEGADOR usa (ws:// em dev, wss:// em produção). */
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** Nomes das salas no LiveKit: uma por canal de voz e uma por conversa direta em chamada. */
export const roomName = (channelId: number) => `voice-${channelId}`;
export const callRoomName = (dmId: number) => `call-${dmId}`;

export type MediaName = "primary" | "fallback";
export interface MediaChoice extends MediaConfig {
  name: MediaName;
}

/** O endereço http(s) equivalente ao ws(s) do navegador, para falar com a API do LiveKit. */
export const httpUrlOf = (wsUrl: string) => wsUrl.replace(/^ws/, "http");

/** Verificação padrão: a principal responde "OK" (200) na raiz em até 4 s. */
export async function defaultPing(httpUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${httpUrl}/`, { signal: AbortSignal.timeout(4000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

const CHECK_EVERY_MS = 30_000;
/** Quantas verificações seguidas iguais são precisas para trocar o estado (evita pisca-pisca). */
const STREAK = 2;

/**
 * Escolhe o servidor de mídia de cada sala: a principal (LiveKit próprio) enquanto estiver saudável, senão a reserva.
 * Cada sala fica presa ao servidor em que começou, até esvaziar: quem entra depois vai para o mesmo servidor
 * (se ele caiu, a conexão falha, em vez de dividir a sala em dois servidores que não se ouvem).
 */
export class MediaPool {
  private healthy = true;
  private streak = 0; // verificações seguidas que discordam do estado atual
  private rooms = new Map<string, { name: MediaName; users: Set<number> }>();
  private listeners: Array<(healthy: boolean) => void> = [];

  constructor(
    private cfg: { primary: MediaConfig | null; fallback: MediaConfig },
    private ping: (httpUrl: string) => Promise<boolean> = defaultPing,
  ) {}

  get primaryHealthy() {
    return this.cfg.primary !== null && this.healthy;
  }

  get hasPrimary() {
    return this.cfg.primary !== null;
  }

  configOf(name: MediaName): MediaConfig {
    return name === "primary" && this.cfg.primary ? this.cfg.primary : this.cfg.fallback;
  }

  pick(room: string, userId: number): MediaChoice {
    let entry = this.rooms.get(room);
    if (!entry) {
      entry = { name: this.primaryHealthy ? "primary" : "fallback", users: new Set() };
      this.rooms.set(room, entry);
    }
    entry.users.add(userId);
    return { name: entry.name, ...this.configOf(entry.name) };
  }

  left(room: string, userId: number) {
    const entry = this.rooms.get(room);
    if (!entry) return;
    entry.users.delete(userId);
    if (entry.users.size === 0) this.rooms.delete(room);
  }

  serverOf(room: string): MediaName | undefined {
    return this.rooms.get(room)?.name;
  }

  onChange(cb: (healthy: boolean) => void) {
    this.listeners.push(cb);
  }

  /** `initial`: a primeira verificação depois de ligar vale sozinha (uma principal morta no boot não recebe ninguém). */
  async check(initial = false) {
    if (!this.cfg.primary) return;
    let ok: boolean;
    try {
      ok = await this.ping(httpUrlOf(this.cfg.primary.url));
    } catch {
      ok = false;
    }
    if (ok === this.healthy) {
      this.streak = 0;
      return;
    }
    this.streak += 1;
    if (initial || this.streak >= STREAK) {
      this.healthy = ok;
      this.streak = 0;
      // na partida só avisa se a principal já está fora do ar ("voltou" sem "caiu" não faz sentido)
      if (!initial || !ok) for (const cb of this.listeners) cb(ok);
    }
  }

  /** Liga a verificação periódica; devolve a função que desliga. */
  start(): () => void {
    void this.check(true);
    const timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    timer.unref();
    return () => clearInterval(timer);
  }
}
