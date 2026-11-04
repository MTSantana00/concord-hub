import type { Member } from "./socket";

/** Tira acentos e maiúsculas para a busca achar "joao" em "João". */
const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * O "@algo" que está logo antes do cursor (precisa vir no começo ou depois de um espaço), ou null.
 * `start` é a posição do "@"; `query` é o que já foi digitado depois dele.
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@(\w{0,32})$/.exec(before);
  return m ? { start: before.length - m[2].length - 1, query: m[2] } : null;
}

/** Quem combina com o que foi digitado (usuário, apelido no servidor ou nome de exibição); quem começa com o texto vem primeiro. */
export function filterMembers(members: Member[], query: string, limit = 8): Member[] {
  const q = plain(query);
  const scored: [number, Member][] = [];
  for (const m of members) {
    const names = [m.username, m.nickname ?? "", m.displayName ?? ""].map(plain).filter(Boolean);
    if (!q) scored.push([1, m]);
    else if (names.some((n) => n.startsWith(q))) scored.push([0, m]);
    else if (names.some((n) => n.includes(q))) scored.push([1, m]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].username.localeCompare(b[1].username)).slice(0, limit).map(([, m]) => m);
}

/** Troca o "@parcial" por "@usuario " e diz onde o cursor deve ficar. */
export function applyMention(text: string, start: number, caret: number, username: string): { text: string; caret: number } {
  const inserted = `@${username} `;
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length };
}
