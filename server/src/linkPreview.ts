import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Db } from "./db.js";

export interface Preview {
  url: string;
  title: string;
  description: string;
  site: string;
}

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;
const CACHE_HOURS = 24;

/** Endereço que qualquer um na internet pode alcançar: nada de rede interna, loopback, link-local ou reservado. */
export function isPublicAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local (inclui metadados de nuvem)
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false; // multicast e reservados
    return true;
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^(?:0{0,4}:){0,5}(?:ffff:)(\d+\.\d+\.\d+\.\d+)$/) ?? lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (lower === "::" || lower === "::1") return false;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 (privado)
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 (link-local)
    if ((first & 0xff00) === 0xff00) return false; // multicast
    return true;
  }
  return false;
}

/** Só http/https nas portas comuns, sem usuário e senha, e com nome de site de verdade. */
export function parseTarget(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port !== "" && url.port !== "80" && url.port !== "443") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (net.isIP(host) !== 0 && !isPublicAddress(host)) return null;
  return url;
}

type Lookup = (hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void) => void;

/** Resolve o nome e só deixa conectar se TODOS os endereços forem públicos (a conexão usa exatamente este resultado). */
const safeLookup: Lookup = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, undefined);
    if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
      return callback(Object.assign(new Error("Endereço não permitido"), { code: "EBLOCKED" }), undefined);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const clean = (s: string | undefined, max: number) =>
  // eslint-disable-next-line no-control-regex
  decodeEntities(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Título, descrição e nome do site a partir do HTML (Open Graph primeiro, depois as etiquetas comuns). */
export function parsePreview(html: string, url: string): Preview | null {
  const head = html.slice(0, MAX_BYTES);
  const metas = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const value = /content\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /content\s*=\s*'([^']*)'/i.exec(tag)?.[1];
    if (key && value !== undefined && !metas.has(key)) metas.set(key, value);
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = clean(metas.get("og:title") ?? metas.get("twitter:title") ?? titleTag, 150);
  const description = clean(metas.get("og:description") ?? metas.get("twitter:description") ?? metas.get("description"), 300);
  const site = clean(metas.get("og:site_name"), 60) || new URL(url).hostname.replace(/^www\./, "");
  if (title === "" && description === "") return null;
  return { url, title, description, site };
}

function get(url: URL): Promise<{ status: number; location?: string; html?: string }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(
      url,
      {
        lookup: safeLookup as never,
        timeout: TIMEOUT_MS,
        headers: { "User-Agent": "ConcordHub-LinkPreview/1.0", Accept: "text/html" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, location: res.headers.location });
          return;
        }
        if (status !== 200 || !/^(text\/html|application\/xhtml\+xml)/i.test(String(res.headers["content-type"] ?? ""))) {
          res.resume();
          resolve({ status });
          return;
        }
        const parts: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          parts.push(chunk);
          if (size >= MAX_BYTES) {
            res.destroy(); // já temos o começo da página, onde ficam as etiquetas
            resolve({ status, html: Buffer.concat(parts).toString("utf8") });
          }
        });
        res.on("end", () => resolve({ status, html: Buffer.concat(parts).toString("utf8") }));
        res.on("error", () => resolve({ status, html: Buffer.concat(parts).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado")));
    req.on("error", reject);
  });
}

/** Busca a página (até 3 redirecionamentos, cada um validado de novo) e extrai a prévia; null se não der. */
export async function fetchPreview(rawUrl: string): Promise<Preview | null> {
  let url = parseTarget(rawUrl);
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
    let result;
    try {
      result = await get(url);
    } catch {
      return null;
    }
    if (result.location) {
      url = parseTarget(new URL(result.location, url).toString());
      continue;
    }
    return result.html === undefined ? null : parsePreview(result.html, rawUrl);
  }
  return null;
}

interface Row {
  ok: number;
  title: string;
  description: string;
  site: string;
  fresh: number;
}

/** Prévia com cache de 24 h (inclusive para quem não tem prévia, para não insistir em sites que não respondem). */
export async function previewFor(db: Db, rawUrl: string, fetcher: (u: string) => Promise<Preview | null> = fetchPreview): Promise<Preview | null> {
  const cached = db
    .prepare(
      `SELECT ok, title, description, site, (fetched_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${CACHE_HOURS} hours')) AS fresh
       FROM link_previews WHERE url = ?`,
    )
    .get(rawUrl) as Row | undefined;
  if (cached?.fresh) return cached.ok ? { url: rawUrl, title: cached.title, description: cached.description, site: cached.site } : null;
  const preview = await fetcher(rawUrl);
  db.prepare(
    `INSERT INTO link_previews (url, ok, title, description, site) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET ok = excluded.ok, title = excluded.title, description = excluded.description,
       site = excluded.site, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(rawUrl, preview ? 1 : 0, preview?.title ?? "", preview?.description ?? "", preview?.site ?? "");
  return preview;
}
