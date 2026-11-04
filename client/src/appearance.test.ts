import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCENTS, applyAppearance, darken, loadAppearance } from "./appearance";

afterEach(() => {
  vi.unstubAllGlobals(); // primeiro: o teste do localStorage bloqueado troca o objeto inteiro
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

describe("loadAppearance", () => {
  it("sem nada guardado: tema automático, primeira cor e letra média", () => {
    expect(loadAppearance()).toEqual({ theme: "auto", accent: ACCENTS[0].id, fontSize: "medium" });
  });

  it("lê o que foi guardado e ignora valores inválidos ou conteúdo estragado", () => {
    localStorage.setItem("concord.appearance", JSON.stringify({ theme: "light", accent: "rosa", fontSize: "large" }));
    expect(loadAppearance()).toEqual({ theme: "light", accent: "rosa", fontSize: "large" });
    localStorage.setItem("concord.appearance", JSON.stringify({ theme: "neon", accent: "xyz", fontSize: 99 }));
    expect(loadAppearance()).toEqual({ theme: "auto", accent: "vermelho", fontSize: "medium" });
    localStorage.setItem("concord.appearance", "{isso não é json");
    expect(loadAppearance().theme).toBe("auto");
  });

  it("se o navegador bloqueia o armazenamento, usa o padrão sem quebrar", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("bloqueado");
      },
    });
    expect(loadAppearance().theme).toBe("auto");
  });
});

describe("applyAppearance", () => {
  const ligarClaro = (claro: boolean) =>
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: claro && q.includes("light"), addEventListener() {}, removeEventListener() {} }));

  it("tema escuro e claro explícitos", () => {
    applyAppearance({ theme: "dark", accent: "azul", fontSize: "medium" });
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyAppearance({ theme: "light", accent: "azul", fontSize: "medium" });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("automático segue o sistema", () => {
    ligarClaro(true);
    applyAppearance({ theme: "auto", accent: "azul", fontSize: "medium" });
    expect(document.documentElement.dataset.theme).toBe("light");
    ligarClaro(false);
    applyAppearance({ theme: "auto", accent: "azul", fontSize: "medium" });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("cor de destaque (com o hover mais escuro) e tamanho da letra", () => {
    applyAppearance({ theme: "dark", accent: "verde", fontSize: "large" });
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--accent")).toBe("#2d9d5c");
    expect(style.getPropertyValue("--accent-hover")).toBe(darken("#2d9d5c"));
    expect(style.fontSize).toBe("18px");
    applyAppearance({ theme: "dark", accent: "azul", fontSize: "small" });
    expect(style.fontSize).toBe("14px");
  });
});

describe("darken", () => {
  it("escurece cada canal na proporção pedida", () => {
    expect(darken("#ffffff", 0.5)).toBe("#808080");
    expect(darken("#000000")).toBe("#000000");
    expect(darken("#5865f2", 0)).toBe("#5865f2");
  });
});
