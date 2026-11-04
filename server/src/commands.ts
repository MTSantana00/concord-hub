import { randomInt } from "node:crypto";

export interface CommandError {
  error: string;
}

const MAX_DICE = 10;
const MAX_SIDES = 1000;
const MAX_CHOICES = 25;

/**
 * Comandos de barra que viram texto da própria mensagem. O sorteio acontece aqui, no servidor,
 * para ninguém poder forjar um resultado. Texto que não é um comando conhecido passa direto
 * (assim "/home/pasta" continua sendo só uma mensagem). /enquete e /ajuda ficam no cliente.
 */
export function runCommand(text: string): string | CommandError {
  const match = /^\/([a-zà-ú]+)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return text;
  const name = match[1].toLowerCase();
  const arg = (match[2] ?? "").trim();

  switch (name) {
    case "dado":
    case "d": {
      const spec = arg === "" ? "1d6" : arg.toLowerCase();
      const m = /^(\d{1,2})?d(\d{1,4})$/.exec(spec);
      if (!m) return { error: "Use /dado, /dado d20 ou /dado 2d6" };
      const count = m[1] === undefined ? 1 : Number(m[1]);
      const sides = Number(m[2]);
      if (count < 1 || count > MAX_DICE || sides < 2 || sides > MAX_SIDES) {
        return { error: `Dados: de 1 a ${MAX_DICE} dados, com 2 a ${MAX_SIDES} lados` };
      }
      const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
      const total = rolls.reduce((a, b) => a + b, 0);
      return count === 1 ? `🎲 rolou d${sides}: **${total}**` : `🎲 rolou ${count}d${sides}: ${rolls.join(" + ")} = **${total}**`;
    }
    case "moeda":
      return `🪙 jogou a moeda: **${randomInt(2) === 0 ? "cara" : "coroa"}**`;
    case "sortear": {
      const options = arg.split(/[,;\n]/).map((o) => o.trim()).filter(Boolean);
      if (options.length < 2) return { error: "Use /sortear opção 1, opção 2, opção 3" };
      if (options.length > MAX_CHOICES) return { error: `Sorteio: no máximo ${MAX_CHOICES} opções` };
      return `🎯 sorteou **${options[randomInt(options.length)]}** (entre: ${options.join(", ")})`;
    }
    case "spoiler":
      if (arg === "") return { error: "Use /spoiler texto escondido" };
      return arg.includes("||") ? { error: "O texto do spoiler não pode ter ||" } : `||${arg}||`;
    case "me":
      if (arg === "") return { error: "Use /me faz alguma coisa" };
      return arg.includes("*") ? arg : `*${arg}*`;
    case "shrug":
      return `${arg} ¯\\_(ツ)_/¯`.trim();
    case "tableflip":
      return `${arg} (╯°□°)╯︵ ┻━┻`.trim();
    case "unflip":
      return `${arg} ┬─┬ ノ( ゜-゜ノ)`.trim();
    default:
      return text;
  }
}
