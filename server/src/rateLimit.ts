import type { Request, RequestHandler, Response } from "express";

/** Conta acessos por chave numa janela de tempo (em memória; zera se o servidor reinicia). */
export class WindowCounter {
  private hits = new Map<string, number[]>();

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Registra um acesso. Devolve 0 se pode passar, ou quantos segundos faltam para poder de novo. */
  hit(key: string): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + this.windowMs - t) / 1000));
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.sweep(t);
    return 0;
  }

  private sweep(t: number) {
    for (const [key, list] of this.hits) if (list.every((at) => t - at >= this.windowMs)) this.hits.delete(key);
  }
}

export interface LimitSpec {
  max: number;
  windowMs: number;
  /** Frase que a pessoa vê; recebe os segundos de espera. */
  message: (seconds: number) => string;
  /** O que identifica quem está sendo contado: a pessoa logada ou o endereço. */
  by: "user" | "ip";
}

/** Middleware que responde 429 quando a pessoa (ou o endereço) passa do limite. */
export function limiter(spec: LimitSpec, enabled: boolean): RequestHandler {
  if (!enabled) return (_req, _res, next) => next();
  const counter = new WindowCounter(spec.max, spec.windowMs);
  return (req: Request, res: Response, next) => {
    const key = spec.by === "user" ? String(res.locals.userId ?? req.ip) : (req.ip ?? "?");
    const wait = counter.hit(key);
    if (wait === 0) return next();
    res.set("Retry-After", String(wait));
    res.status(429).json({ error: spec.message(wait) });
  };
}

const secs = (n: number) => `${n} ${n === 1 ? "segundo" : "segundos"}`;

export const LIMITS = {
  text: { max: 12, windowMs: 10_000, by: "user", message: (n) => `Calma! Você está enviando mensagens rápido demais. Tente de novo em ${secs(n)}.` },
  uploads: { max: 10, windowMs: 60_000, by: "user", message: (n) => `Muitos anexos em pouco tempo. Tente de novo em ${secs(n)}.` },
  reactions: { max: 30, windowMs: 10_000, by: "user", message: (n) => `Reagindo rápido demais. Tente de novo em ${secs(n)}.` },
  login: { max: 20, windowMs: 15 * 60_000, by: "ip", message: (n) => `Muitas tentativas de entrar. Tente de novo em ${secs(n)}.` },
  register: { max: 10, windowMs: 60 * 60_000, by: "ip", message: (n) => `Muitas contas criadas deste endereço. Tente de novo em ${secs(n)}.` },
  oauth: { max: 60, windowMs: 15 * 60_000, by: "ip", message: (n) => `Muitas tentativas de entrar. Tente de novo em ${secs(n)}.` },
  forgot: { max: 10, windowMs: 60 * 60_000, by: "ip", message: (n) => `Muitos pedidos de recuperação deste endereço. Tente de novo em ${secs(n)}.` },
  reset: { max: 20, windowMs: 15 * 60_000, by: "ip", message: (n) => `Muitas tentativas com código. Tente de novo em ${secs(n)}.` },
  emailCode: { max: 10, windowMs: 60 * 60_000, by: "user", message: (n) => `Muitos códigos pedidos. Tente de novo em ${secs(n)}.` },
  joinInvite: { max: 30, windowMs: 60 * 60_000, by: "ip", message: (n) => `Muitas tentativas com convites. Tente de novo em ${secs(n)}.` },
} satisfies Record<string, LimitSpec>;
