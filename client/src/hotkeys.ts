import { useEffect, useRef, useSyncExternalStore } from "react";

export type HotkeyAction = "toggleMute" | "toggleDeafen" | "toggleCamera" | "toggleScreen" | "leaveCall" | "quickSwitcher" | "prevChannel" | "nextChannel";

export interface HotkeyInfo {
  id: HotkeyAction;
  label: string;
  /** Só faz sentido numa chamada (no app de computador também vale com a janela em segundo plano). */
  call?: boolean;
  defaultCombo: string;
}

/** Os atalhos configuráveis. Os padrões usam Alt+Shift para não esbarrar nos atalhos do navegador. */
export const HOTKEYS: HotkeyInfo[] = [
  { id: "toggleMute", label: "Mutar / ativar o microfone", call: true, defaultCombo: "Alt+Shift+KeyM" },
  { id: "toggleDeafen", label: "Ensurdecer / voltar a ouvir", call: true, defaultCombo: "Alt+Shift+KeyD" },
  { id: "toggleCamera", label: "Ligar / desligar a câmera", call: true, defaultCombo: "Alt+Shift+KeyV" },
  { id: "toggleScreen", label: "Compartilhar / parar a tela", call: true, defaultCombo: "Alt+Shift+KeyS" },
  { id: "leaveCall", label: "Sair da chamada", call: true, defaultCombo: "Alt+Shift+KeyL" },
  { id: "quickSwitcher", label: "Ir para um canal (busca rápida)", defaultCombo: "Ctrl+KeyK" },
  { id: "prevChannel", label: "Canal de texto anterior", defaultCombo: "Alt+ArrowUp" },
  { id: "nextChannel", label: "Próximo canal de texto", defaultCombo: "Alt+ArrowDown" },
];

export type HotkeyConfig = Record<HotkeyAction, string>;

const KEY = "concord.hotkeys";
const defaults = (): HotkeyConfig => Object.fromEntries(HOTKEYS.map((h) => [h.id, h.defaultCombo])) as HotkeyConfig;

function load(): HotkeyConfig {
  const cfg = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Record<string, unknown>> | null;
    for (const h of HOTKEYS) if (typeof saved?.[h.id] === "string") cfg[h.id] = saved[h.id] as string; // "" = desligado
  } catch {
    // armazenamento ilegível: vale o padrão
  }
  return cfg;
}

let current = load();
const listeners = new Set<() => void>();
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // sem armazenamento: vale até recarregar
  }
  for (const l of listeners) l();
};

export const getHotkeys = () => current;
export function setHotkey(action: HotkeyAction, combo: string) {
  current = { ...current, [action]: combo };
  save();
}
export function resetHotkeys() {
  current = defaults();
  save();
}
/** Recarrega do armazenamento (os testes limpam o localStorage entre um teste e outro). */
export function reloadHotkeys() {
  current = load();
  for (const l of listeners) l();
}
export function useHotkeyConfig(): HotkeyConfig {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

type KeyLike = Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "code">;

/** O atalho que um evento de teclado representa, ex.: "Alt+Shift+KeyM"; null se só apertou modificadores. */
export function comboFromEvent(e: KeyLike): string | null {
  if (!e.code || MODIFIER_CODES.test(e.code)) return null;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", e.code].filter(Boolean).join("+");
}

/** O evento aciona este atalho? (No Mac, Cmd vale como Ctrl nos atalhos que usam Ctrl.) */
export function matches(e: KeyLike, combo: string): boolean {
  if (!combo) return false;
  if (comboFromEvent(e) === combo) return true;
  return combo.includes("Ctrl+") && !combo.includes("Meta+") && e.metaKey && !e.ctrlKey && comboFromEvent({ ...e, ctrlKey: true, metaKey: false }) === combo;
}

const HAS_MODIFIER = /(^|\+)(Ctrl|Alt|Meta)\+/;
const IS_FKEY = /(^|\+)F([1-9]|1[0-2])$/;

/** Um atalho precisa de Ctrl, Alt ou Cmd (ou ser uma tecla F): letra solta atrapalharia quem está digitando. */
export function isValidCombo(combo: string): boolean {
  return HAS_MODIFIER.test(combo) || IS_FKEY.test(combo);
}

const PRETTY_KEYS: Record<string, string> = {
  ArrowUp: "Seta ↑",
  ArrowDown: "Seta ↓",
  ArrowLeft: "Seta ←",
  ArrowRight: "Seta →",
  Space: "Espaço",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Backslash: "\\",
  Slash: "/",
  Period: ".",
  Comma: ",",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
};
const prettyPart = (part: string) => PRETTY_KEYS[part] ?? part.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ");

/** "Alt+Shift+KeyM" vira "Alt + Shift + M", para mostrar na tela. */
export function prettyCombo(combo: string): string {
  return combo ? combo.split("+").map(prettyPart).join(" + ") : "Sem atalho";
}

/** Quem já usa esse atalho (outra ação), se alguém. */
export function conflictFor(cfg: HotkeyConfig, action: HotkeyAction, combo: string): HotkeyInfo | undefined {
  return HOTKEYS.find((h) => h.id !== action && cfg[h.id] === combo);
}

/** Ponte com o app de computador (Electron): atalhos globais, que valem até com a janela em segundo plano. */
export interface DesktopBridge {
  setHotkeys?: (config: Partial<HotkeyConfig>) => void;
  onHotkey?: (listener: (action: HotkeyAction) => void) => () => void;
}
declare global {
  interface Window {
    concordDesktop?: DesktopBridge;
  }
}

let capturing = false;
/** Enquanto a pessoa grava um atalho novo, nenhum atalho dispara (senão apertar a combinação já executaria a ação). */
export function setHotkeyCapturing(on: boolean) {
  capturing = on;
}

function typingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** Liga os atalhos configurados às ações. Letra solta nunca vale: só combinações com Ctrl, Alt ou Cmd, ou teclas F. */
export function useHotkeys(handlers: Partial<Record<HotkeyAction, () => void>>) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const cfg = useHotkeyConfig();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || capturing) return;
      for (const h of HOTKEYS) {
        const fn = ref.current[h.id];
        if (!fn || !matches(e, cfg[h.id])) continue;
        if (typingTarget(e.target) && !isValidCombo(cfg[h.id])) continue;
        e.preventDefault();
        fn();
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cfg]);

  // app de computador: manda os atalhos de chamada para o sistema e recebe o aviso quando um é apertado
  useEffect(() => {
    window.concordDesktop?.setHotkeys?.(Object.fromEntries(HOTKEYS.filter((h) => h.call).map((h) => [h.id, cfg[h.id]])));
  }, [cfg]);
  useEffect(() => window.concordDesktop?.onHotkey?.((action) => ref.current[action]?.()), []);
}
