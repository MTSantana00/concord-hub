import { useEffect, useRef } from "react";

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Janela de verdade para teclado e leitor de tela: ao abrir, o foco vai para ela; Tab e Shift+Tab ficam dentro;
 * Esc fecha; ao fechar, o foco volta para quem abriu. Use: `const dialog = useDialog(onClose)` e `<div role="dialog" {...dialog}>`.
 */
export function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement & HTMLFormElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.closest("[hidden]") && getComputedStyle(n).display !== "none" && getComputedStyle(n).visibility !== "hidden");
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || active === el)) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return { ref, tabIndex: -1 } as const;
}
