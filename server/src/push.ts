import webpush from "web-push";
import { audience } from "./channelAccess.js";
import type { Db } from "./db.js";
import type { Hub } from "./hub.js";
import { mentionsUser } from "./unread.js";

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  /** Contato exigido pelo padrão (mailto: ou https:). */
  subject: string;
}

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Manda uma notificação a uma assinatura. Lança um erro com `statusCode` 404/410 quando a assinatura morreu. */
export type Sender = (sub: Subscription, payload: string) => Promise<unknown>;

export const MAX_SUBSCRIPTIONS_PER_USER = 10;
const MAX_BODY = 120;

export function realSender(cfg: PushConfig): Sender {
  return (sub, payload) => {
    // ligação só vale enquanto toca: depois de 30 s o aviso não serve mais, e chega com urgência
    const call = (() => {
      try {
        return (JSON.parse(payload) as { kind?: string }).kind === "call";
      } catch {
        return false;
      }
    })();
    return webpush.sendNotification(sub, payload, {
      vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey },
      TTL: call ? 30 : 60 * 60,
      urgency: call ? "high" : "normal",
    });
  };
}

/** Chaves novas (uma vez só; guarde na configuração do servidor). */
export const generateKeys = () => webpush.generateVAPIDKeys();

interface MessageLike {
  id: number;
  channelId: number | null;
  dmId: number | null;
  serverId: number | null;
  content: string;
  audio?: unknown;
  attachment?: { name: string } | null;
  author: { id: number; username: string; displayName?: string | null };
}

/**
 * Notificação com o aplicativo fechado: quem NÃO tem o app aberto (nenhuma conexão) recebe aviso de
 * mensagens diretas e de menções (@usuario) nos canais, desde que não esteja em "Não perturbe" nem tenha silenciado o lugar.
 */
export class PushService {
  constructor(
    private db: Db,
    private hub: Hub,
    private cfg: PushConfig | null,
    private sender: Sender | null = cfg ? realSender(cfg) : null,
  ) {}

  get publicKey(): string | null {
    return this.cfg?.publicKey ?? null;
  }

  subscribe(userId: number, sub: Subscription) {
    // O mesmo aparelho (endereço) pertence a uma conta só: se outra conta entrou nele, passa para ela
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(sub.endpoint);
    this.db
      .prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)")
      .run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
    this.db
      .prepare(
        `DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN
         (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(userId, userId, MAX_SUBSCRIPTIONS_PER_USER);
  }

  unsubscribe(userId: number, endpoint: string) {
    this.db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(userId, endpoint);
  }

  /** A pessoa tem algum aparelho assinado e não está em "Não perturbe": dá para avisar de uma ligação com o app fechado. */
  canNotifyCall(userId: number): boolean {
    if (!this.sender) return false;
    const subs = this.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").get(userId) as { n: number };
    const u = this.db.prepare("SELECT status_kind FROM users WHERE id = ?").get(userId) as { status_kind: string } | undefined;
    return subs.n > 0 && !!u && u.status_kind !== "dnd";
  }

  /** Ligação recebida com o app fechado: o aparelho toca/vibra e, ao tocar na notificação, o app abre já com a chamada. */
  notifyCall(calleeId: number, callerName: string, dmId: number) {
    if (!this.canNotifyCall(calleeId)) return;
    this.notifyUsers([calleeId], { title: `📞 ${callerName} está ligando`, body: "Toque para atender", tag: `call-${dmId}`, kind: "call" });
  }

  /** Notificação direta (avisos de limite da administradora): vai a todos os aparelhos, mesmo com o app aberto. */
  notifyUsers(userIds: number[], note: { title: string; body: string; tag: string; kind?: "call" }) {
    const send = this.sender;
    if (!send || userIds.length === 0) return;
    const payload = JSON.stringify(note);
    const stmt = this.db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?");
    for (const userId of userIds) {
      for (const s of stmt.all(userId) as { endpoint: string; p256dh: string; auth: string }[]) {
        send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload).catch((err: unknown) => {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(s.endpoint);
        });
      }
    }
  }

  /** Chamado quando uma mensagem é criada. Não espera nem lança: falha de envio nunca atrapalha o chat. */
  onMessage(m: MessageLike) {
    if (!this.sender) return;
    try {
      void this.dispatch(m, this.sender).catch(() => {});
    } catch {
      // nunca atrapalha o envio da mensagem
    }
  }

  private recipients(m: MessageLike): number[] {
    if (m.dmId !== null) {
      const dm = this.db.prepare("SELECT user_a, user_b FROM dm_conversations WHERE id = ?").get(m.dmId) as { user_a: number; user_b: number } | undefined;
      return dm ? [dm.user_a === m.author.id ? dm.user_b : dm.user_a] : [];
    }
    if (m.channelId === null) return [];
    const names = new Map(
      (this.db.prepare("SELECT id, username FROM users").all() as { id: number; username: string }[]).map((u) => [u.id, u.username]),
    );
    return audience(this.db, m.channelId).filter((id) => id !== m.author.id && mentionsUser(m.content, names.get(id) ?? "\u0000"));
  }

  private muted(userId: number, m: MessageLike): boolean {
    const kinds: [string, number | null][] = [
      ["dm", m.dmId],
      ["channel", m.channelId],
      ["server", m.serverId],
    ];
    const stmt = this.db.prepare("SELECT 1 FROM mutes WHERE user_id = ? AND kind = ? AND target_id = ?");
    return kinds.some(([kind, id]) => id !== null && !!stmt.get(userId, kind, id));
  }

  private async dispatch(m: MessageLike, send: Sender) {
    const targets = this.recipients(m).filter((id) => {
      if (this.hub.hasConnection(id)) return false; // com o app aberto, quem avisa é a própria página
      const u = this.db.prepare("SELECT status_kind FROM users WHERE id = ?").get(id) as { status_kind: string } | undefined;
      return !!u && u.status_kind !== "dnd" && !this.muted(id, m);
    });
    if (targets.length === 0) return;

    const nick = m.serverId !== null ? (this.db.prepare("SELECT nickname FROM members WHERE server_id = ? AND user_id = ?").get(m.serverId, m.author.id) as { nickname: string | null } | undefined)?.nickname : null;
    const who = nick || m.author.displayName || m.author.username;
    let where = "";
    if (m.channelId !== null) {
      const ch = this.db.prepare("SELECT c.name, s.name AS server FROM channels c JOIN servers s ON s.id = c.server_id WHERE c.id = ?").get(m.channelId) as { name: string; server: string } | undefined;
      where = ch ? ` em #${ch.name} (${ch.server})` : "";
    }
    const text = m.content || (m.audio ? "enviou uma mensagem de voz" : m.attachment ? "enviou um arquivo" : "");
    const payload = JSON.stringify({
      title: `${who}${where}`,
      body: text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text,
      tag: m.dmId !== null ? `dm-${m.dmId}` : `ch-${m.channelId}`,
    });

    for (const userId of targets) {
      const subs = this.db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?").all(userId) as {
        endpoint: string;
        p256dh: string;
        auth: string;
      }[];
      await Promise.all(
        subs.map(async (s) => {
          try {
            await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(s.endpoint); // o aparelho desinstalou/negou
          }
        }),
      );
    }
  }
}
