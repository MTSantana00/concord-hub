import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountNotices, POLICY_VERSION } from "./AccountNotices";
import { AuthProvider } from "./AuthContext";
import { notifyAsked } from "./NotifyOnboarding";

vi.mock("./push", () => ({ enablePush: vi.fn(async () => {}), pushSupported: vi.fn(() => true) }));

function stub(user: Record<string, unknown>, mailEnabled: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const body = path === "/api/auth/me" ? { user } : path === "/api/auth/mail" ? { enabled: mailEnabled } : {};
      return { ok: true, status: 200, json: async () => body };
    }),
  );
}
const show = (onOpen = vi.fn()) => {
  render(
    <AuthProvider>
      <AccountNotices onOpenAccount={onOpen} />
    </AuthProvider>,
  );
  return onOpen;
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("avisos da conta", () => {
  it("política nova: avisa uma vez, com links, e lembra que já foi lido", async () => {
    stub({ id: 1, username: "ana", emailVerified: true }, false);
    show();
    expect(await screen.findByText(/Atualizamos a/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "política de privacidade" }).getAttribute("href")).toBe("/privacidade.html");
    await userEvent.click(screen.getByRole("button", { name: "Entendi" }));
    expect(screen.queryByText(/Atualizamos a/)).toBeNull();
    expect(localStorage.getItem("concord.policy-seen")).toBe(POLICY_VERSION);

    cleanup();
    show();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/auth/mail", expect.anything()));
    expect(screen.queryByText(/Atualizamos a/)).toBeNull();
  });

  it("com envio de e-mail ligado, conta sem e-mail confirmado é convidada a adicionar um", async () => {
    localStorage.setItem("concord.policy-seen", POLICY_VERSION);
    stub({ id: 1, username: "ana", emailVerified: false, emailPending: false }, true);
    const abrir = show();
    await userEvent.click(await screen.findByRole("button", { name: "Adicionar e-mail" }));
    expect(abrir).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Agora não" }));
    expect(screen.queryByRole("button", { name: "Adicionar e-mail" })).toBeNull();
    expect(localStorage.getItem("concord.email-nudge")).toBe("1");
  });

  it("sem aviso quando o e-mail já está confirmado ou o servidor não envia e-mail", async () => {
    localStorage.setItem("concord.policy-seen", POLICY_VERSION);
    stub({ id: 1, username: "ana", emailVerified: true, email: "ana@exemplo.com" }, true);
    show();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/auth/mail", expect.anything()));
    expect(screen.queryByRole("region", { name: "Avisos da conta" })).toBeNull();
    cleanup();

    stub({ id: 2, username: "beto", emailVerified: false }, false);
    show();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/auth/mail", expect.anything()));
    expect(screen.queryByRole("button", { name: "Adicionar e-mail" })).toBeNull();
  });

  it("outro aparelho (a conta foi criada em outro): pergunta das notificações uma vez e lembra a resposta", async () => {
    localStorage.setItem("concord.policy-seen", POLICY_VERSION);
    vi.stubGlobal("Notification", Object.assign(function () {}, { permission: "default", requestPermission: async () => "granted" }));
    stub({ id: 4, username: "ana", emailVerified: true }, false);
    show();
    expect(await screen.findByText(/mensagens privadas, menções e ligações/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Ativar avisos" }));
    expect(await screen.findByText(/Pronto!/)).toBeTruthy();
    expect(notifyAsked(4)).toBe(true);

    cleanup();
    stub({ id: 4, username: "ana", emailVerified: true }, false);
    show();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/auth/mail", expect.anything()));
    expect(screen.queryByRole("button", { name: "Ativar avisos" })).toBeNull(); // já respondeu neste aparelho
  });

  it("'Dispensar' também vale por este aparelho; navegador sem notificação nem pergunta", async () => {
    localStorage.setItem("concord.policy-seen", POLICY_VERSION);
    vi.stubGlobal("Notification", Object.assign(function () {}, { permission: "default", requestPermission: async () => "granted" }));
    stub({ id: 5, username: "beto", emailVerified: true }, false);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Dispensar" }));
    expect(notifyAsked(5)).toBe(true);
    expect(screen.queryByRole("button", { name: "Ativar avisos" })).toBeNull();
  });
});
