import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";
import type { Db } from "./db.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Quem entrega o e-mail (SMTP de verdade; os testes trocam por um falso). */
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/**
 * Envio por SMTP, tudo por variáveis de ambiente (qualquer provedor grátis serve, ex.: Gmail com senha de app).
 * Sem SMTP_HOST/SMTP_USER/SMTP_PASS o recurso de e-mail fica desligado e o app funciona como antes.
 */
export function smtpMailerFromEnv(env: Record<string, string | undefined>): Mailer | null {
  const host = env.SMTP_HOST;
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const port = Number(env.SMTP_PORT ?? 465);
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass }, connectionTimeout: 10_000, socketTimeout: 15_000 });
  const from = env.MAIL_FROM || `Concord Hub <${user}>`;
  return { send: async (msg) => void (await transport.sendMail({ from, ...msg })) };
}

const CODE_TTL_MS = 15 * 60_000;
const RESEND_AFTER_MS = 60_000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

export type Purpose = "verify" | "reset";
export type MailResult = { ok: true } | { ok: false; status: number; error: string };

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
export const normalizeEmail = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Moldura simples e legível em qualquer leitor de e-mail (estilo inline, sem imagens externas). */
function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#0b0c10;padding:24px;font-family:Segoe UI,Arial,sans-serif;color:#eceef4">
<div style="max-width:480px;margin:0 auto;background:#12141b;border:1px solid #2a3042;border-radius:14px;padding:28px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#9ba2b4">Concord Hub</p>
<h1 style="margin:0 0 16px;font-size:20px;color:#fff">${esc(title)}</h1>
${bodyHtml}
<p style="margin:24px 0 0;font-size:12px;color:#6c7488">Se não foi você, é só ignorar este e-mail.</p>
</div></body></html>`;
}
const codeBox = (code: string) =>
  `<p style="margin:16px 0;padding:14px;text-align:center;font-size:30px;letter-spacing:.4em;font-weight:700;background:#0b0c10;border:1px solid #2a3042;border-radius:10px;color:#fff">${code}</p>`;
const p = (t: string) => `<p style="margin:0 0 12px;line-height:1.5;color:#d3d7e2">${t}</p>`;

export const templates = {
  verify: (code: string): Omit<MailMessage, "to"> => ({
    subject: `${code} é o seu código do Concord Hub`,
    text: `Seu código de confirmação do Concord Hub: ${code}\n\nEle vale por 15 minutos. Se não foi você, ignore este e-mail.`,
    html: layout("Confirme o seu e-mail", p("Digite este código no Concord Hub para confirmar que o e-mail é seu:") + codeBox(code) + p("Ele vale por 15 minutos.")),
  }),
  reset: (code: string, username: string): Omit<MailMessage, "to"> => ({
    subject: `${code} é o seu código para recuperar a conta`,
    text: `Alguém pediu para recuperar a conta "${username}" no Concord Hub.\n\nSeu código: ${code}\n\nEle vale por 15 minutos. Se não foi você, ignore este e-mail: a sua senha não muda sem o código.`,
    html: layout("Recuperar a conta", p(`Alguém pediu para recuperar a conta <strong>${esc(username)}</strong>. Digite este código para escolher uma senha nova:`) + codeBox(code) + p("Ele vale por 15 minutos. A sua senha não muda sem esse código.")),
  }),
  welcome: (username: string, url: string | null): Omit<MailMessage, "to"> => ({
    subject: "Bem-vindo(a) ao Concord Hub!",
    text: `Oi, ${username}! Obrigado por criar sua conta no Concord Hub. Seu e-mail está confirmado.\n\nAgora é só chamar os amigos, criar salas de voz e conversar sem pressa.${url ? `\n\nEntrar: ${url}` : ""}\n\nSe um dia esquecer a senha, use "Esqueci a senha" na tela de entrada: mandamos um código para este e-mail.`,
    html: layout(
      `Bem-vindo(a), ${username}!`,
      p("Obrigado por criar sua conta no Concord Hub. Seu e-mail está confirmado.") +
        p("Agora é só chamar os amigos, criar salas de voz e conversar sem pressa.") +
        (url ? `<p style="margin:16px 0"><a href="${esc(url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#b3121b;color:#fff;text-decoration:none;font-weight:600">Abrir o Concord Hub</a></p>` : "") +
        p('Se um dia esquecer a senha, use <strong>Esqueci a senha</strong> na tela de entrada: mandamos um código para este e-mail.'),
    ),
  }),
  accountDeleted: (username: string): Omit<MailMessage, "to"> => ({
    subject: "Sua conta do Concord Hub foi excluída",
    text: `A conta "${username}" foi excluída do Concord Hub, junto com as suas mensagens, conversas e arquivos. Cópias de segurança antigas são descartadas em até 14 dias. Se não foi você, fale com quem administra o servidor.`,
    html: layout("Conta excluída", p(`A conta <strong>${esc(username)}</strong> foi excluída do Concord Hub, junto com as suas mensagens, conversas e arquivos.`) + p("Cópias de segurança antigas são descartadas em até 14 dias.")),
  }),
  passwordChanged: (username: string): Omit<MailMessage, "to"> => ({
    subject: "Sua senha do Concord Hub foi alterada",
    text: `A senha da conta "${username}" no Concord Hub acabou de ser alterada. Se não foi você, recupere a conta pela tela de entrada ("Esqueci a senha") ou fale com quem administra o servidor.`,
    html: layout("Senha alterada", p(`A senha da conta <strong>${esc(username)}</strong> acabou de ser alterada.`) + p('Se não foi você, recupere a conta pela tela de entrada ("Esqueci a senha") ou fale com quem administra o servidor.')),
  }),
};

/** Códigos por e-mail (confirmar o endereço e recuperar a senha) e mensagens da conta. */
export class MailService {
  constructor(
    private db: Db,
    private mailer: Mailer | null,
    private secret: string,
    private publicUrl: string | null = null,
    private now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.mailer !== null;
  }

  private hash(purpose: Purpose, userId: number, email: string, code: string): string {
    return createHmac("sha256", this.secret).update(`${purpose}:${userId}:${email}:${code}`).digest("hex");
  }

  /** Manda uma mensagem sem derrubar quem chamou: falha de e-mail vira só um aviso no log. */
  async notify(to: string, msg: Omit<MailMessage, "to">): Promise<boolean> {
    if (!this.mailer) return false;
    try {
      await this.mailer.send({ to, ...msg });
      return true;
    } catch (err) {
      console.error("Falha ao enviar e-mail:", err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** Gera e envia um código novo (com intervalo mínimo e teto por hora, por pessoa). */
  async sendCode(purpose: Purpose, userId: number, email: string, username: string): Promise<MailResult> {
    if (!this.mailer) return { ok: false, status: 503, error: "O envio de e-mail não está ligado neste servidor." };
    const t = this.now();
    this.db.prepare("DELETE FROM email_codes WHERE created_at < ?").run(t - 24 * 3_600_000);
    const recent = this.db.prepare("SELECT created_at FROM email_codes WHERE user_id = ? AND purpose = ? AND created_at > ? ORDER BY created_at DESC").all(userId, purpose, t - 3_600_000) as { created_at: number }[];
    if (recent.length && t - recent[0].created_at < RESEND_AFTER_MS) {
      const wait = Math.ceil((RESEND_AFTER_MS - (t - recent[0].created_at)) / 1000);
      return { ok: false, status: 429, error: `Espere ${wait} segundos para pedir outro código.` };
    }
    if (recent.length >= MAX_SENDS_PER_HOUR) return { ok: false, status: 429, error: "Muitos códigos pedidos. Tente de novo daqui a pouco." };

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    // o código antigo deixa de valer assim que sai um novo
    this.db.prepare("UPDATE email_codes SET expires_at = 0 WHERE user_id = ? AND purpose = ?").run(userId, purpose);
    this.db
      .prepare("INSERT INTO email_codes (purpose, user_id, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(purpose, userId, email, this.hash(purpose, userId, email, code), t + CODE_TTL_MS, t);
    const msg = purpose === "verify" ? templates.verify(code) : templates.reset(code, username);
    try {
      await this.mailer.send({ to: email, ...msg });
    } catch (err) {
      console.error("Falha ao enviar e-mail:", err instanceof Error ? err.message : err);
      this.db.prepare("UPDATE email_codes SET expires_at = 0 WHERE user_id = ? AND purpose = ?").run(userId, purpose);
      return { ok: false, status: 502, error: "Não foi possível enviar o e-mail agora. Tente de novo em instantes." };
    }
    return { ok: true };
  }

  /** Confere o código (no máximo 5 tentativas por código). Devolve o e-mail ao qual ele foi enviado. */
  checkCode(purpose: Purpose, userId: number, code: unknown): { ok: true; email: string } | { ok: false; status: number; error: string } {
    const row = this.db
      .prepare("SELECT id, email, code_hash, attempts FROM email_codes WHERE user_id = ? AND purpose = ? AND expires_at > ? ORDER BY id DESC LIMIT 1")
      .get(userId, purpose, this.now()) as { id: number; email: string; code_hash: string; attempts: number } | undefined;
    if (!row) return { ok: false, status: 400, error: "Código vencido ou não encontrado. Peça um novo." };
    if (row.attempts >= MAX_ATTEMPTS) return { ok: false, status: 429, error: "Muitas tentativas erradas. Peça um novo código." };
    this.db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    const typed = typeof code === "string" ? code.replace(/\s+/g, "") : "";
    const expected = Buffer.from(row.code_hash, "hex");
    const got = Buffer.from(/^\d{6}$/.test(typed) ? this.hash(purpose, userId, row.email, typed) : "0".repeat(64), "hex");
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, status: 400, error: "Código errado." };
    this.db.prepare("UPDATE email_codes SET expires_at = 0 WHERE user_id = ? AND purpose = ?").run(userId, purpose);
    return { ok: true, email: row.email };
  }

  welcome(username: string): Omit<MailMessage, "to"> {
    return templates.welcome(username, this.publicUrl);
  }
}
