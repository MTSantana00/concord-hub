import { describe, expect, it } from "vitest";
import { localCommand, parsePollCommand, suggestions } from "./slashCommands";

describe("comandos de barra (cliente)", () => {
  it("sugere pelo começo do nome, só enquanto digita o nome", () => {
    expect(suggestions("/", false).length).toBeGreaterThan(5);
    expect(suggestions("/da", false).map((c) => c.name)).toEqual(["dado"]);
    expect(suggestions("/DA", false).map((c) => c.name)).toEqual(["dado"]);
    expect(suggestions("/dado 2d6", false)).toEqual([]);
    expect(suggestions("oi /dado", false)).toEqual([]);
    expect(suggestions("", false)).toEqual([]);
  });

  it("enquete não é sugerida em conversa direta", () => {
    expect(suggestions("/enq", false).map((c) => c.name)).toEqual(["enquete"]);
    expect(suggestions("/enq", true)).toEqual([]);
  });

  it("só /enquete e /ajuda são resolvidos no cliente", () => {
    expect(localCommand("/enquete a | b | c")?.command.name).toBe("enquete");
    expect(localCommand("/enquete a | b | c")?.arg).toBe("a | b | c");
    expect(localCommand("/ajuda")?.command.name).toBe("ajuda");
    expect(localCommand("/dado 2d6")).toBeNull();
    expect(localCommand("/home/pasta")).toBeNull();
    expect(localCommand("oi")).toBeNull();
  });

  it("/enquete: pergunta e opções separadas por |, sem repetir; erros claros", () => {
    expect(parsePollCommand("Qual jogo? | Minecraft |  Valorant | Minecraft | ")).toEqual({
      question: "Qual jogo?",
      options: ["Minecraft", "Valorant"],
      multiple: false,
    });
    expect(parsePollCommand("só pergunta")).toMatch(/Use \/enquete/);
    expect(parsePollCommand("q | a")).toMatch(/Use \/enquete/);
    expect(parsePollCommand(" | a | b")).toMatch(/Use \/enquete/);
    expect(parsePollCommand("q | " + Array.from({ length: 11 }, (_, i) => `o${i}`).join(" | "))).toMatch(/no máximo 10/);
  });
});
