// Converte o atalho do site ("Alt+Shift+KeyM") no formato do Electron ("Alt+Shift+M").
// Fica separado do main.js para poder ser testado sem abrir janela.

const NAMED = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Space: "Space",
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
  Enter: "Return",
  Tab: "Tab",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
};

const MODIFIERS = { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Super" };

function keyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  return NAMED[code] ?? null;
}

/** Devolve o atalho no formato do Electron, ou null se a combinação não serve como atalho global. */
function toAccelerator(combo) {
  if (typeof combo !== "string" || combo === "") return null;
  const parts = combo.split("+");
  const code = parts.pop();
  const key = keyName(code);
  if (!key) return null;
  const mods = [];
  for (const p of parts) {
    if (!MODIFIERS[p] || mods.includes(MODIFIERS[p])) return null;
    mods.push(MODIFIERS[p]);
  }
  // letra solta como atalho global tomaria a tecla do computador inteiro: só vale com modificador (ou tecla F)
  const isFKey = /^F\d+$/.test(key);
  const hasModifier = mods.some((m) => m === "Ctrl" || m === "Alt" || m === "Super");
  if (!hasModifier && !isFKey) return null;
  return [...mods, key].join("+");
}

/** As ações que o site pode pedir como atalho global (as de chamada). */
const GLOBAL_ACTIONS = ["toggleMute", "toggleDeafen", "toggleCamera", "toggleScreen", "leaveCall"];

/** Valida o que o site mandou e devolve [ação, atalho] só do que é seguro registrar (sem repetir atalho). */
function parseHotkeyConfig(config) {
  if (!config || typeof config !== "object") return [];
  const seen = new Set();
  const out = [];
  for (const action of GLOBAL_ACTIONS) {
    const accelerator = toAccelerator(config[action]);
    if (!accelerator || seen.has(accelerator)) continue;
    seen.add(accelerator);
    out.push([action, accelerator]);
  }
  return out;
}

module.exports = { toAccelerator, parseHotkeyConfig, GLOBAL_ACTIONS };
