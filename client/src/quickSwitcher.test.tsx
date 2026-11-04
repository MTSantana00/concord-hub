import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickSwitcher, filterTargets, type SwitchTarget } from "./QuickSwitcher";

afterEach(cleanup);

const targets: SwitchTarget[] = [
  { serverId: 1, serverName: "Os Parças", channelId: 10, channelName: "geral" },
  { serverId: 1, serverName: "Os Parças", channelId: 11, channelName: "café" },
  { serverId: 2, serverName: "Jogatina", channelId: 20, channelName: "geral-jogos" },
  { serverId: 2, serverName: "Jogatina", channelId: 21, channelName: "memes" },
];

describe("filterTargets", () => {
  it("sem texto, lista os primeiros; ignora acento, maiúscula e o # inicial", () => {
    expect(filterTargets(targets, "")).toHaveLength(4);
    expect(filterTargets(targets, "CAFE").map((t) => t.channelId)).toEqual([11]);
    expect(filterTargets(targets, "#mem").map((t) => t.channelId)).toEqual([21]);
  });

  it("quem começa com o texto vem antes de quem só contém; também acha pelo nome do servidor", () => {
    expect(filterTargets(targets, "jogo").map((t) => t.channelId)).toEqual([20]); // só geral-jogos contém "jogo"
    expect(filterTargets(targets, "ger").map((t) => t.channelId)).toEqual([10, 20]);
    expect(filterTargets(targets, "jogatina").map((t) => t.channelId)).toEqual([20, 21]);
    expect(filterTargets(targets, "zzz")).toEqual([]);
  });

  it("respeita o limite", () => {
    expect(filterTargets(targets, "", 2)).toHaveLength(2);
  });
});

describe("QuickSwitcher", () => {
  it("setas escolhem, Enter vai, Esc fecha", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<QuickSwitcher targets={targets} onPick={onPick} onClose={onClose} />);
    const input = screen.getByLabelText("Buscar canal");
    expect(document.activeElement).toBe(input);
    await userEvent.type(input, "ger{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith(targets[2]);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("clicar escolhe; sem resultado avisa e Enter não faz nada", async () => {
    const onPick = vi.fn();
    render(<QuickSwitcher targets={targets} onPick={onPick} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /memes/ }));
    expect(onPick).toHaveBeenCalledWith(targets[3]);
    await userEvent.type(screen.getByLabelText("Buscar canal"), "zzz{Enter}");
    expect(screen.getByText("Nenhum canal encontrado.")).toBeTruthy();
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
