import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PollCard, PollForm, type Poll } from "./Poll";
import { RichText } from "./RichText";

afterEach(cleanup);

describe("formatação extra", () => {
  it("spoiler fica escondido até clicar; clicar de novo esconde; Enter também alterna", async () => {
    render(<RichText text="o final é ||o mordomo||" />);
    const spoiler = screen.getByRole("button", { name: /Spoiler escondido/ });
    expect(spoiler.className).not.toContain("shown");
    expect(spoiler.textContent).toBe("o mordomo");
    await userEvent.click(spoiler);
    expect(screen.getByRole("button", { name: /clique para esconder/ }).className).toContain("shown");
    await userEvent.click(screen.getByRole("button", { name: /clique para esconder/ }));
    expect(screen.getByRole("button", { name: /Spoiler escondido/ }).className).not.toContain("shown");
    fireEvent.keyDown(screen.getByRole("button", { name: /Spoiler escondido/ }), { key: "Enter" });
    expect(screen.getByRole("button", { name: /clique para esconder/ }).className).toContain("shown");
  });

  it("sublinhado, e formatação dentro do spoiler", () => {
    const { container } = render(<RichText text="__importante__ e ||**negrito** secreto||" />);
    expect(container.querySelector("u")?.textContent).toBe("importante");
    expect(container.querySelector(".spoiler strong")?.textContent).toBe("negrito");
  });

  it("citação: linhas com '> ' viram um bloco só; o resto fica normal", () => {
    const { container } = render(<RichText text={"antes\n> linha 1\n> linha 2\ndepois"} />);
    const quotes = container.querySelectorAll("blockquote.msg-quote");
    expect(quotes).toHaveLength(1);
    expect(quotes[0].textContent).toBe("linha 1\nlinha 2");
    expect(container.textContent).toContain("antes");
    expect(container.textContent).toContain("depois");
  });

  it("'>' sem espaço, ou no meio da frase, não vira citação; blocos de código preservam o '> '", () => {
    const { container } = render(<RichText text={">sem espaço e 1 > 0\n```\n> código\n```"} />);
    expect(container.querySelector("blockquote")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe("> código");
  });

  it("texto malicioso continua sendo só texto", () => {
    const { container } = render(<RichText text={"||<img src=x onerror=alert(1)>||"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".spoiler")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("enquete na mensagem", () => {
  const poll: Poll = {
    multiple: false,
    options: [
      { id: 1, text: "Minecraft", users: [10, 11, 12] },
      { id: 2, text: "Valorant", users: [13] },
      { id: 3, text: "CS", users: [] },
    ],
  };

  it("mostra votos, porcentagem, seu voto e o total de pessoas", () => {
    render(<PollCard poll={poll} userId={13} onVote={() => {}} />);
    expect(screen.getByRole("button", { name: /Minecraft: 3 votos \(75%\)$/ })).toBeTruthy();
    const meu = screen.getByRole("button", { name: /Valorant: 1 voto \(25%\), seu voto/ });
    expect(meu.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /CS: 0 votos \(0%\)/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(/4 pessoas votaram · escolha uma opção/)).toBeTruthy();
  });

  it("clicar numa opção chama onVote com o id; enquete de várias opções avisa", async () => {
    const onVote = vi.fn();
    render(<PollCard poll={{ ...poll, multiple: true }} userId={99} onVote={onVote} />);
    await userEvent.click(screen.getByRole("button", { name: /Valorant/ }));
    expect(onVote).toHaveBeenCalledWith(2);
    expect(screen.getByText(/escolha quantas quiser/)).toBeTruthy();
  });

  it("sem votos: 0% e 'nenhuma pessoa' no singular/plural certo", () => {
    render(<PollCard poll={{ multiple: false, options: [{ id: 1, text: "A", users: [] }, { id: 2, text: "B", users: [] }] }} userId={1} onVote={() => {}} />);
    expect(screen.getByText(/0 pessoas votaram/)).toBeTruthy();
  });
});

describe("formulário de enquete", () => {
  it("só habilita com pergunta e 2 opções; adiciona e remove opções; envia limpando espaços", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<PollForm onCreate={onCreate} onCancel={() => {}} />);
    const criar = screen.getByRole("button", { name: "Criar enquete" }) as HTMLButtonElement;
    expect(criar.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Pergunta da enquete"), "  Qual jogo?  ");
    await userEvent.type(screen.getByLabelText("Opção 1"), "Minecraft");
    expect(criar.disabled).toBe(true); // só 1 opção
    await userEvent.type(screen.getByLabelText("Opção 2"), " Valorant ");
    expect(criar.disabled).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "+ Adicionar opção" }));
    expect(screen.getByLabelText("Opção 3")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remover opção 3" }));
    expect(screen.queryByLabelText("Opção 3")).toBeNull();
    await userEvent.click(screen.getByLabelText(/várias opções/));
    await userEvent.click(criar);
    expect(onCreate).toHaveBeenCalledWith({ question: "Qual jogo?", options: ["Minecraft", "Valorant"], multiple: true });
  });

  it("mostra o erro do servidor e continua editável", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("Modo lento: espere 3 s para enviar de novo"));
    render(<PollForm onCreate={onCreate} onCancel={() => {}} />);
    await userEvent.type(screen.getByLabelText("Pergunta da enquete"), "q");
    await userEvent.type(screen.getByLabelText("Opção 1"), "a");
    await userEvent.type(screen.getByLabelText("Opção 2"), "b");
    await userEvent.click(screen.getByRole("button", { name: "Criar enquete" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Modo lento/);
    expect((screen.getByRole("button", { name: "Criar enquete" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("limita a 10 opções", async () => {
    render(<PollForm onCreate={vi.fn()} onCancel={() => {}} />);
    for (let i = 0; i < 8; i++) await userEvent.click(screen.getByRole("button", { name: "+ Adicionar opção" }));
    expect(screen.getByLabelText("Opção 10")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ Adicionar opção" })).toBeNull();
  });
});
