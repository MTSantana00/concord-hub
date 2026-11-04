import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSettings } from "./Account";
import { App } from "./App";
import { AuthProvider } from "./AuthContext";

type Reply = { status: number; body?: unknown };

/** fetch falso: cada rota "MÉTODO /caminho" devolve a resposta (ou uma função que decide). */
function stub(routes: Record<string, Reply | (() => Reply)>) {
  const calls: { key: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      const key = `${init?.method ?? "GET"} ${path}`;
      calls.push({ key, body: init?.body ? JSON.parse(init.body) : undefined });
      const r = routes[key];
      const reply: Reply = typeof r === "function" ? r() : (r ?? { status: 404, body: { error: "não achei" } });
      return { ok: reply.status < 400, status: reply.status, json: async () => reply.body ?? {} };
    }),
  );
  return calls;
}

const naoLogado: Reply = { status: 401, body: { error: "Não autenticado" } };
const providers: Reply = { status: 200, body: { google: false, github: false } };
const pendente = { id: 1, username: "ana", emailPending: true, emailVerified: false, email: null, pendingEmail: "ana@exemplo.com" };

beforeEach(() => window.history.replaceState({}, "", "/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("e-mail: cadastro, confirmação e esqueci a senha (cliente)", () => {
  it("sem envio de e-mail no servidor, nada de e-mail aparece", async () => {
    stub({ "GET /api/auth/me": naoLogado, "GET /api/auth/mail": { status: 200, body: { enabled: false } }, "GET /api/auth/oauth/providers": providers });
    render(<App />);
    await screen.findByRole("button", { name: "Entrar" });
    expect(screen.queryByRole("button", { name: "Esqueci a senha" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Registre-se/ }));
    expect(screen.queryByLabelText("E-mail")).toBeNull();
  });

  it("com e-mail ligado: o cadastro pede o e-mail e o envia junto", async () => {
    const calls = stub({
      "GET /api/auth/me": naoLogado,
      "GET /api/auth/mail": { status: 200, body: { enabled: true } },
      "GET /api/auth/oauth/providers": providers,
      "POST /api/auth/register": { status: 201, body: { user: pendente } },
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Registre-se/ }));
    await userEvent.type(await screen.findByLabelText("Usuário"), "ana");
    await userEvent.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
    await userEvent.type(screen.getByLabelText("Senha"), "senha-bem-longa");
    await userEvent.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(calls.find((c) => c.key === "POST /api/auth/register")?.body).toEqual({ username: "ana", password: "senha-bem-longa", email: "ana@exemplo.com" });
    // conta nova sem e-mail confirmado: o app pede o código antes de abrir
    expect(await screen.findByRole("heading", { name: "Confirme o seu e-mail" })).toBeTruthy();
  });

  it("tela de confirmação: digita o código, confirma e dá para pedir outro", async () => {
    const calls = stub({
      "GET /api/auth/me": { status: 200, body: { user: pendente } },
      "GET /api/auth/mail": { status: 200, body: { enabled: true } },
      "POST /api/auth/email/verify": { status: 200, body: { email: "ana@exemplo.com", emailVerified: true, emailPending: false } },
      "POST /api/auth/email/send-code": { status: 204 },
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Confirme o seu e-mail" });
    expect((screen.getByLabelText("E-mail") as HTMLInputElement).value).toBe("ana@exemplo.com"); // o e-mail do cadastro já vem preenchido
    await userEvent.click(screen.getByRole("button", { name: "Não chegou? Enviar de novo" }));
    expect(calls.find((c) => c.key === "POST /api/auth/email/send-code")?.body).toEqual({ email: "ana@exemplo.com" });
    expect(await screen.findByText("Código enviado para ana@exemplo.com.")).toBeTruthy();

    await userEvent.type(screen.getByLabelText("Código de 6 dígitos"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirmar e-mail" }));
    expect(calls.find((c) => c.key === "POST /api/auth/email/verify")?.body).toEqual({ code: "123456" });
  });

  it("esqueci a senha: e-mail, depois código e senha nova; erro do servidor aparece", async () => {
    let reset: Reply = { status: 400, body: { error: "Código errado ou vencido." } };
    const calls = stub({
      "GET /api/auth/me": () => (reset.status === 204 ? { status: 200, body: { user: pendente } } : naoLogado),
      "GET /api/auth/mail": { status: 200, body: { enabled: true } },
      "GET /api/auth/oauth/providers": providers,
      "POST /api/auth/forgot": { status: 204 },
      "POST /api/auth/reset": () => reset,
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Esqueci a senha" }));
    await userEvent.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
    await userEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    expect(calls.find((c) => c.key === "POST /api/auth/forgot")?.body).toEqual({ email: "ana@exemplo.com" });

    await userEvent.type(await screen.findByLabelText("Código de 6 dígitos"), "000000");
    await userEvent.type(screen.getByLabelText("Nova senha"), "nova-senha-123");
    await userEvent.type(screen.getByLabelText("Repita a nova senha"), "outra-coisa-123");
    await userEvent.click(screen.getByRole("button", { name: "Trocar a senha e entrar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("As duas senhas não são iguais");

    await userEvent.clear(screen.getByLabelText("Repita a nova senha"));
    await userEvent.type(screen.getByLabelText("Repita a nova senha"), "nova-senha-123");
    await userEvent.click(screen.getByRole("button", { name: "Trocar a senha e entrar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Código errado ou vencido.");

    reset = { status: 204 };
    await userEvent.click(screen.getByRole("button", { name: "Trocar a senha e entrar" }));
    expect(calls.filter((c) => c.key === "POST /api/auth/reset").at(-1)?.body).toEqual({ email: "ana@exemplo.com", code: "000000", password: "nova-senha-123" });
    // o servidor já deixou logado: o app relê quem sou eu
    expect(await screen.findByRole("heading", { name: "Confirme o seu e-mail" })).toBeTruthy();
  });
});

describe("aceite dos termos e exclusão da conta (cliente)", () => {
  it("login e cadastro linkam os termos e a política; o cadastro avisa que criar a conta é aceitar", async () => {
    stub({ "GET /api/auth/me": naoLogado, "GET /api/auth/mail": { status: 200, body: { enabled: false } }, "GET /api/auth/oauth/providers": providers });
    render(<App />);
    await screen.findByRole("button", { name: "Entrar" });
    expect(screen.getByRole("link", { name: "Termos de uso" }).getAttribute("href")).toBe("/termos.html");
    expect(screen.getByRole("link", { name: "Privacidade" }).getAttribute("href")).toBe("/privacidade.html");
    expect(screen.getByRole("link", { name: "Licenças de terceiros" }).getAttribute("href")).toBe("/licencas.html");
    expect(screen.queryByText(/você concorda com/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Registre-se/ }));
    const aviso = screen.getByText(/Ao criar a conta, você concorda com os/);
    expect(aviso.textContent).toContain("Termos de uso");
    expect(aviso.textContent).toContain("Política de privacidade");
    expect(aviso.querySelectorAll("a")).toHaveLength(2);
  });

  it("Minha conta: excluir só habilita ao digitar o usuário; erro do servidor aparece; sucesso sai da conta", async () => {
    let apagar: Reply = { status: 403, body: { error: "A senha está errada." } };
    const calls = stub({
      "GET /api/auth/me": () => ({ status: 200, body: { user: { id: 1, username: "ana" } } }),
      "GET /api/auth/mail": { status: 200, body: { enabled: false } },
      "GET /api/auth/oauth/identities": { status: 200, body: { identities: [], hasPassword: true } },
      "POST /api/auth/delete-account": () => apagar,
      "POST /api/auth/logout": { status: 204 },
    });
    render(
      <AuthProvider>
        <AccountSettings onClose={() => {}} />
      </AuthProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Excluir minha conta…" }));
    const excluir = screen.getByRole("button", { name: "Excluir para sempre" }) as HTMLButtonElement;
    expect(excluir.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/Digite o seu usuário/), "ana");
    await userEvent.type(screen.getByLabelText(/^Senha \(deixe em branco/), "senha-errada");
    expect(excluir.disabled).toBe(false);

    await userEvent.click(excluir);
    expect(calls.find((c) => c.key === "POST /api/auth/delete-account")?.body).toEqual({ confirm: "ana", password: "senha-errada" });
    expect((await screen.findByText("A senha está errada.")).getAttribute("role")).toBe("alert");

    apagar = { status: 204 };
    await userEvent.click(screen.getByRole("button", { name: "Excluir para sempre" }));
    await vi.waitFor(() => expect(calls.some((c) => c.key === "POST /api/auth/logout")).toBe(true));
  });
});
