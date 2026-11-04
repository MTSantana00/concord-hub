import { beforeEach, describe, expect, it } from "vitest";
import { HOTKEYS, comboFromEvent, conflictFor, getHotkeys, isValidCombo, matches, prettyCombo, reloadHotkeys, resetHotkeys, setHotkey } from "./hotkeys";

const key = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

beforeEach(() => {
  localStorage.clear();
  reloadHotkeys();
});

describe("atalhos: combinação", () => {
  it("monta a combinação pelo código da tecla (independe do idioma do teclado) e ignora só-modificador", () => {
    expect(comboFromEvent(key("KeyM", { altKey: true, shiftKey: true }))).toBe("Alt+Shift+KeyM");
    expect(comboFromEvent(key("ArrowUp", { altKey: true }))).toBe("Alt+ArrowUp");
    expect(comboFromEvent(key("F5"))).toBe("F5");
    expect(comboFromEvent(key("ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(comboFromEvent(key("ControlRight", { ctrlKey: true }))).toBeNull();
  });

  it("confere o evento com o atalho; no Mac, Cmd vale como Ctrl", () => {
    expect(matches(key("KeyK", { ctrlKey: true }), "Ctrl+KeyK")).toBe(true);
    expect(matches(key("KeyK", { metaKey: true }), "Ctrl+KeyK")).toBe(true);
    expect(matches(key("KeyK", { ctrlKey: true, shiftKey: true }), "Ctrl+KeyK")).toBe(false); // modificador a mais não vale
    expect(matches(key("KeyK"), "Ctrl+KeyK")).toBe(false);
    expect(matches(key("KeyK", { ctrlKey: true }), "")).toBe(false); // atalho limpo nunca dispara
  });

  it("só aceita combinação com Ctrl, Alt ou Cmd (ou tecla F): letra solta atrapalharia quem digita", () => {
    for (const ok of ["Ctrl+KeyK", "Alt+Shift+KeyM", "Meta+KeyJ", "F9", "Shift+F2"]) expect(isValidCombo(ok), ok).toBe(true);
    for (const bad of ["KeyM", "Shift+KeyM", "Space", "ArrowUp", "F13"]) expect(isValidCombo(bad), bad).toBe(false);
  });

  it("mostra de forma legível", () => {
    expect(prettyCombo("Alt+Shift+KeyM")).toBe("Alt + Shift + M");
    expect(prettyCombo("Alt+ArrowUp")).toBe("Alt + Seta ↑");
    expect(prettyCombo("Ctrl+Digit1")).toBe("Ctrl + 1");
    expect(prettyCombo("")).toBe("Sem atalho");
  });
});

describe("atalhos: configuração", () => {
  it("começa nos padrões, guarda a troca, aceita desligar e volta aos padrões", () => {
    expect(getHotkeys().toggleMute).toBe("Alt+Shift+KeyM");
    setHotkey("toggleMute", "Ctrl+Alt+KeyJ");
    setHotkey("toggleCamera", ""); // desligado
    reloadHotkeys(); // como depois de recarregar a página
    expect(getHotkeys().toggleMute).toBe("Ctrl+Alt+KeyJ");
    expect(getHotkeys().toggleCamera).toBe("");
    expect(getHotkeys().leaveCall).toBe("Alt+Shift+KeyL");
    resetHotkeys();
    expect(getHotkeys().toggleMute).toBe("Alt+Shift+KeyM");
    expect(getHotkeys().toggleCamera).toBe("Alt+Shift+KeyV");
  });

  it("os padrões não se repetem e todos são válidos", () => {
    const combos = HOTKEYS.map((h) => h.defaultCombo);
    expect(new Set(combos).size).toBe(combos.length);
    for (const c of combos) expect(isValidCombo(c), c).toBe(true);
  });

  it("diz quem já usa o atalho (só outra ação, nunca a própria)", () => {
    const cfg = getHotkeys();
    expect(conflictFor(cfg, "toggleDeafen", "Alt+Shift+KeyM")?.id).toBe("toggleMute");
    expect(conflictFor(cfg, "toggleMute", "Alt+Shift+KeyM")).toBeUndefined();
    expect(conflictFor(cfg, "toggleMute", "Ctrl+Alt+KeyZ")).toBeUndefined();
  });

  it("ignora lixo guardado", () => {
    localStorage.setItem("concord.hotkeys", JSON.stringify({ toggleMute: 42, leaveCall: "Alt+KeyQ", inventado: "Ctrl+KeyX" }));
    reloadHotkeys();
    expect(getHotkeys().toggleMute).toBe("Alt+Shift+KeyM");
    expect(getHotkeys().leaveCall).toBe("Alt+KeyQ");
    localStorage.setItem("concord.hotkeys", "{isso não é json");
    reloadHotkeys();
    expect(getHotkeys().leaveCall).toBe("Alt+Shift+KeyL");
  });
});
