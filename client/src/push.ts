import { api } from "./api";

/** O navegador sabe receber notificações com o app fechado? (No iPhone só depois de instalar o app na tela de início.) */
export function pushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A assinatura deste aparelho, se houver. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** Chave do servidor; null se o servidor não tem as notificações ligadas. */
export async function serverKey(): Promise<string | null> {
  const d = await api<{ publicKey: string | null }>("/api/push/key");
  return d.publicKey;
}

/** Pede permissão, assina neste aparelho e registra no servidor. Lança Error com texto para mostrar. */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error("Este navegador não recebe notificações com o app fechado. No iPhone, instale o app na tela de início primeiro.");
  const key = await serverKey();
  if (!key) throw new Error("Este servidor ainda não liga as notificações com o app fechado.");
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("O navegador bloqueou as notificações. Libere nas configurações do site e tente de novo.");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  await api<void>("/api/push/subscribe", "POST", sub.toJSON());
}

/** Cancela neste aparelho (no servidor e no navegador). */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api<void>("/api/push/subscribe", "DELETE", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
