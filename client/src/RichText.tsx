import { useState, type ReactNode } from "react";

const URL_AT_START = /^https?:\/\/[^\s<>]+/i;
// ordem importa: `código`, ||spoiler||, **negrito**, __sublinhado__, ~~riscado~~, *itálico*, link
const INLINE = /(`[^`\n]+`)|(\|\|[^\n]+?\|\|)|(\*\*[^\n]+?\*\*)|(__[^\n]+?__)|(~~[^\n]+?~~)|(\*[^*\n]+?\*)|(https?:\/\/[^\s<>]+)/g;
const TRAILING = /[.,!?;:)\]}'"]+$/;

/** Só links http/https de verdade; devolve o endereço sem a pontuação do fim da frase. */
function cleanLink(raw: string): { href: string; rest: string } | null {
  const href = raw.replace(TRAILING, "");
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { href, rest: raw.slice(href.length) };
}

/** Os links http(s) de um texto, na ordem em que aparecem (sem repetir). */
export function extractLinks(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>]+/gi)) {
    const link = cleanLink(m[0]);
    if (link && !found.includes(link.href)) found.push(link.href);
  }
  return found;
}

/** ||spoiler||: fica borrado até clicar (ou apertar Enter/Espaço); clicar de novo esconde. */
function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      className={`spoiler${shown ? " shown" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={shown ? "Spoiler (clique para esconder)" : "Spoiler escondido (clique para mostrar)"}
      onClick={() => setShown((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setShown((v) => !v);
        }
      }}
    >
      {children}
    </span>
  );
}

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyBase}-${n++}`;
    const [token] = m;
    if (m[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<Spoiler key={key}>{inline(token.slice(2, -2), key)}</Spoiler>);
    else if (m[3]) out.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>);
    else if (m[4]) out.push(<u key={key}>{inline(token.slice(2, -2), key)}</u>);
    else if (m[5]) out.push(<s key={key}>{inline(token.slice(2, -2), key)}</s>);
    else if (m[6]) out.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>);
    else {
      const link = URL_AT_START.test(token) ? cleanLink(token) : null;
      if (link) {
        out.push(
          <a key={key} href={link.href} target="_blank" rel="noopener noreferrer nofollow">
            {link.href}
          </a>,
        );
        if (link.rest) out.push(link.rest);
      } else {
        out.push(token);
      }
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Linhas que começam com "> " viram citação (várias seguidas formam um bloco só); o resto segue em linha. */
function lines(text: string, keyBase: string): ReactNode[] {
  if (!/(^|\n)> /.test(text)) return inline(text, keyBase);
  const out: ReactNode[] = [];
  let plain: string[] = [];
  let quote: string[] = [];
  const flushPlain = () => {
    if (plain.length) out.push(...inline(plain.join("\n"), `${keyBase}-p${out.length}`));
    plain = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push(<blockquote key={`${keyBase}-q${out.length}`} className="msg-quote">{inline(quote.join("\n"), `${keyBase}-q${out.length}`)}</blockquote>);
    quote = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("> ")) {
      flushPlain();
      quote.push(line.slice(2));
    } else {
      flushQuote();
      plain.push(line);
    }
  }
  flushPlain();
  flushQuote();
  return out;
}

/**
 * Formatação segura de mensagens: **negrito**, *itálico*, __sublinhado__, ~~riscado~~, ||spoiler||, `código`, citações com "> ", blocos ``` e links.
 * Tudo vira elemento React (nada de HTML cru), então um texto malicioso continua sendo só texto.
 */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/```/);
  // número par de ``` fecha todos os blocos; se sobrar um aberto, o resto é texto comum
  const closed = parts.length % 2 === 1;
  return (
    <>
      {parts.map((part, i) => {
        const isBlock = i % 2 === 1 && (closed || i < parts.length - 1);
        if (isBlock) {
          return (
            <pre key={i} className="code-block">
              <code>{part.replace(/^\n/, "").replace(/\n$/, "")}</code>
            </pre>
          );
        }
        const raw = i % 2 === 1 ? "```" + part : part;
        return <span key={i}>{lines(raw, `t${i}`)}</span>;
      })}
    </>
  );
}
