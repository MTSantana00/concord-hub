const test = require("node:test");
const assert = require("node:assert/strict");
const { toAccelerator, parseHotkeyConfig } = require("../src/accelerator");

test("converte letras, números, setas e teclas F para o formato do Electron", () => {
  assert.equal(toAccelerator("Alt+Shift+KeyM"), "Alt+Shift+M");
  assert.equal(toAccelerator("Ctrl+Alt+Digit1"), "Ctrl+Alt+1");
  assert.equal(toAccelerator("Alt+ArrowUp"), "Alt+Up");
  assert.equal(toAccelerator("Ctrl+Shift+F9"), "Ctrl+Shift+F9");
  assert.equal(toAccelerator("F8"), "F8");
  assert.equal(toAccelerator("Meta+KeyJ"), "Super+J");
  assert.equal(toAccelerator("Ctrl+Backslash"), "Ctrl+\\");
  assert.equal(toAccelerator("Ctrl+Numpad5"), "Ctrl+num5");
});

test("recusa o que não serve como atalho global", () => {
  assert.equal(toAccelerator(""), null);
  assert.equal(toAccelerator(undefined), null);
  assert.equal(toAccelerator(42), null);
  assert.equal(toAccelerator("KeyM"), null); // letra solta tomaria a tecla do computador inteiro
  assert.equal(toAccelerator("Shift+KeyM"), null); // Shift sozinho também
  assert.equal(toAccelerator("Alt+Shift+Inventada"), null); // tecla desconhecida
  assert.equal(toAccelerator("Banana+KeyM"), null); // modificador desconhecido
  assert.equal(toAccelerator("Alt+Alt+KeyM"), null); // modificador repetido
});

test("só aceita as ações de chamada, ignora lixo e não registra o mesmo atalho duas vezes", () => {
  const out = parseHotkeyConfig({
    toggleMute: "Alt+Shift+KeyM",
    toggleDeafen: "Alt+Shift+KeyD",
    toggleCamera: "Alt+Shift+KeyM", // repetido: fica só o primeiro
    toggleScreen: "KeyS", // inválido
    leaveCall: "Alt+Shift+KeyL",
    quickSwitcher: "Ctrl+KeyK", // não é ação global
    formatarDisco: "Ctrl+Alt+KeyX", // inventada
  });
  assert.deepEqual(out, [
    ["toggleMute", "Alt+Shift+M"],
    ["toggleDeafen", "Alt+Shift+D"],
    ["leaveCall", "Alt+Shift+L"],
  ]);
  assert.deepEqual(parseHotkeyConfig(null), []);
  assert.deepEqual(parseHotkeyConfig("texto"), []);
});
