import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSettings } from "./Account";
import { AuthProvider } from "./AuthContext";
import { useDialog } from "./useDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Demo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Abrir</button>
      <button type="button">Fora da janela</button>
      {open && <Janela onClose={() => setOpen(false)} />}
    </>
  );
}
function Janela({ onClose }: { onClose: () => void }) {
  const dialog = useDialog(onClose);
  return (
    <div role="dialog" aria-modal="true" aria-label="Janela de teste" {...dialog}>
      <button type="button" onClick={onClose}>Fechar</button>
      <input aria-label="Campo" />
      <button type="button">Último</button>
    </div>
  );
}

describe("useDialog: teclado nas janelas", () => {
  it("o foco vai para a janela, Tab e Shift+Tab ficam dentro dela, Esc fecha e o foco volta para quem abriu", async () => {
    render(<Demo />);
    const abrir = screen.getByRole("button", { name: "Abrir" });
    await userEvent.click(abrir);
    const janela = screen.getByRole("dialog", { name: "Janela de teste" });
    expect(document.activeElement).toBe(janela);

    await userEvent.tab(); // janela -> primeiro botão
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fechar" }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Campo"));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Último" }));
    await userEvent.tab(); // do último volta ao primeiro, sem sair para a página
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fechar" }));
    await userEvent.tab({ shift: true }); // do primeiro volta ao último
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Último" }));

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(abrir);
  });

  it("Minha conta fecha com Esc", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const user = path === "/api/auth/me" ? { user: { id: 1, username: "ana" } } : {};
        return { ok: path === "/api/auth/me", status: path === "/api/auth/me" ? 200 : 404, json: async () => user };
      }),
    );
    const onClose = vi.fn();
    render(
      <AuthProvider>
        <AccountSettings onClose={onClose} />
      </AuthProvider>,
    );
    const janela = await screen.findByRole("dialog", { name: "Minha conta" });
    expect(document.activeElement).toBe(janela);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
