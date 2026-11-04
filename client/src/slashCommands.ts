export interface SlashCommand {
  name: string;
  /** Como escrever, mostrado na lista de sugestões. */
  usage: string;
  help: string;
  /** Resolvido aqui no cliente; os outros o servidor transforma em mensagem. */
  local?: "poll" | "help";
  /** Só faz sentido em canal de servidor (enquete). */
  channelOnly?: boolean;
}

export const COMMANDS: SlashCommand[] = [
  { name: "dado", usage: "/dado 2d6", help: "Rola dados (padrão d6; até 10 dados de até 1000 lados)" },
  { name: "moeda", usage: "/moeda", help: "Cara ou coroa" },
  { name: "sortear", usage: "/sortear pizza, sushi, lanche", help: "Sorteia uma das opções separadas por vírgula" },
  { name: "enquete", usage: "/enquete Qual jogo? | Minecraft | Valorant", help: "Cria uma enquete (pergunta e opções separadas por |)", local: "poll", channelOnly: true },
  { name: "spoiler", usage: "/spoiler texto", help: "Esconde o texto até alguém clicar", },
  { name: "me", usage: "/me dança", help: "Escreve uma ação em itálico" },
  { name: "shrug", usage: "/shrug sei lá", help: "Acrescenta ¯\\_(ツ)_/¯ ao texto" },
  { name: "tableflip", usage: "/tableflip", help: "Acrescenta (╯°□°)╯︵ ┻━┻ ao texto" },
  { name: "unflip", usage: "/unflip", help: "Acrescenta ┬─┬ ノ( ゜-゜ノ) ao texto" },
  { name: "ajuda", usage: "/ajuda", help: "Lista os comandos", local: "help" },
];

/** Comandos que combinam com o que a pessoa está digitando (só enquanto ainda é o nome do comando, sem espaço). */
export function suggestions(text: string, inDm: boolean): SlashCommand[] {
  const m = /^\/([a-zà-ú]*)$/i.exec(text);
  if (!m) return [];
  const typed = m[1].toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(typed) && !(inDm && c.channelOnly));
}

/** O comando que o texto invoca, se for um dos que o cliente resolve sozinho. */
export function localCommand(text: string): { command: SlashCommand; arg: string } | null {
  const m = /^\/([a-zà-ú]+)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!m) return null;
  const command = COMMANDS.find((c) => c.local && c.name === m[1].toLowerCase());
  return command ? { command, arg: (m[2] ?? "").trim() } : null;
}

/** "Pergunta | opção 1 | opção 2" -> enquete; texto de erro se faltar algo. */
export function parsePollCommand(arg: string): { question: string; options: string[]; multiple: false } | string {
  const parts = arg.split("|").map((p) => p.trim());
  const question = parts[0] ?? "";
  const options = [...new Set(parts.slice(1).filter(Boolean))];
  if (!question || options.length < 2) return "Use /enquete Pergunta | opção 1 | opção 2 (de 2 a 10 opções)";
  if (options.length > 10) return "Uma enquete tem no máximo 10 opções";
  return { question, options, multiple: false };
}
