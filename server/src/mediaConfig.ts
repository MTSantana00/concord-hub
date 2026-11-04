import type { MediaConfig } from "./mediaPool.js";

type Env = Record<string, string | undefined>;

/**
 * Lê os servidores de mídia do ambiente.
 * - Reserva: MEDIA_FALLBACK_URL/KEY/SECRET ou, se faltar, LIVEKIT_URL/API_KEY/API_SECRET (o jeito de sempre).
 * - Principal (opcional): MEDIA_PRIMARY_URL/KEY/SECRET, tudo ou nada.
 */
export function loadMediaConfig(env: Env, isProduction: boolean): { primary: MediaConfig | null; fallback: MediaConfig } {
  const get = (name: string) => env[name] || undefined;

  const primaryParts = [get("MEDIA_PRIMARY_URL"), get("MEDIA_PRIMARY_KEY"), get("MEDIA_PRIMARY_SECRET")];
  let primary: MediaConfig | null = null;
  if (primaryParts.some(Boolean)) {
    const [url, apiKey, apiSecret] = primaryParts;
    if (!url || !apiKey || !apiSecret) throw new Error("MEDIA_PRIMARY_* precisa de URL, KEY e SECRET");
    primary = { url, apiKey, apiSecret };
  }

  const url = get("MEDIA_FALLBACK_URL") ?? get("LIVEKIT_URL") ?? (isProduction ? undefined : "ws://localhost:7880");
  const apiKey = get("MEDIA_FALLBACK_KEY") ?? get("LIVEKIT_API_KEY") ?? (isProduction ? undefined : "devkey");
  const apiSecret = get("MEDIA_FALLBACK_SECRET") ?? get("LIVEKIT_API_SECRET") ?? (isProduction ? undefined : "secret");
  if (!url || !apiKey || !apiSecret) throw new Error("LIVEKIT_API_KEY, LIVEKIT_API_SECRET e LIVEKIT_URL são obrigatórios em produção.");

  return { primary, fallback: { url, apiKey, apiSecret } };
}

/** O que a página precisa poder acessar para falar com os servidores de mídia (política de conteúdo). */
export function connectSources(urls: string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    let host: string;
    try {
      host = new URL(u).host;
    } catch {
      continue;
    }
    out.add(`wss://${host}`);
    out.add(`https://${host}`);
    if (u.startsWith("ws://")) out.add(`ws://${host}`);
  }
  return [...out];
}
