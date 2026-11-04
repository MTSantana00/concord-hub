import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotifyChoice, enableNotifications, notifyAsked } from "./NotifyOnboarding";
import { resetNotifyPrefs, getNotifyPrefs } from "./notifyPrefs";

const push = vi.hoisted(() => ({ enablePush: vi.fn(), pushSupported: vi.fn(() => true) }));
vi.mock("./push", () => push);

function navegador(permission: NotificationPermission, resposta: NotificationPermission = "granted") {
  const requestPermission = vi.fn(async () => resposta);
  vi.stubGlobal("Notification", Object.assign(function () {}, { permission, requestPermission }));
  return requestPermission;
}

beforeEach(() => {
  localStorage.clear();
  resetNotifyPrefs();
  push.enablePush.mockReset().mockResolvedValue(undefined);
  push.pushSupported.mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("perguntar das notificações", () => {
  it("permitir: pede a permissão, liga o aviso do navegador e o do app fechado, e lembra que este aparelho já respondeu", async () => {
    const pedir = navegador("default");
    const onDone = vi.fn();
    render(<NotifyChoice userId={7} onDone={onDone} />);
    expect(screen.getByText(/mensagens privadas/)).toBeTruthy();
    expect(screen.getByText(/ligações/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Permitir notificações" }));
    expect(pedir).toHaveBeenCalledTimes(1);
    expect(push.enablePush).toHaveBeenCalledTimes(1);
    expect(getNotifyPrefs().desktop).toBe(true);
    expect(await screen.findByText(/Pronto!/)).toBeTruthy();
    expect(notifyAsked(7)).toBe(true);
    expect(notifyAsked(8)).toBe(false); // vale por conta e por aparelho

    await userEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("agora não: não pede permissão nenhuma, segue e não pergunta de novo", async () => {
    const pedir = navegador("default");
    const onDone = vi.fn();
    render(<NotifyChoice userId={7} onDone={onDone} />);
    await userEvent.click(screen.getByRole("button", { name: "Agora não" }));
    expect(pedir).not.toHaveBeenCalled();
    expect(push.enablePush).not.toHaveBeenCalled();
    expect(getNotifyPrefs().desktop).toBe(false);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(notifyAsked(7)).toBe(true);
  });

  it("permissão negada: explica como liberar depois e não liga nada", async () => {
    navegador("default", "denied");
    const r = await enableNotifications();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/negada/);
    expect(push.enablePush).not.toHaveBeenCalled();
    expect(getNotifyPrefs().desktop).toBe(false);
  });

  it("sem notificação com o app fechado (ex.: iPhone sem instalar o app): liga a do navegador e explica o resto", async () => {
    navegador("granted");
    push.enablePush.mockRejectedValue(new Error("No iPhone, instale o app na tela de início primeiro."));
    const r = await enableNotifications();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/app aberto em segundo plano/);
    expect(r.message).toMatch(/instale o app na tela de início/);
    expect(getNotifyPrefs().desktop).toBe(true);
  });

  it("navegador sem nenhuma notificação: mostra o passo a passo do iPhone", async () => {
    vi.stubGlobal("Notification", undefined);
    push.pushSupported.mockReturnValue(false);
    const r = await enableNotifications();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Adicionar à Tela de Início/);
  });
});
