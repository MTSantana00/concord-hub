// Ponte segura entre o site e o app de computador. O site só enxerga estas funções, nada do Node.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("concordDesktop", {
  platform: process.platform,
  /** Traz a janela de volta da bandeja (ao clicar numa notificação). */
  show: () => ipcRenderer.send("window:show"),
  /** Manda os atalhos de chamada escolhidos em Minha conta → Atalhos; o app os registra no sistema. */
  setHotkeys: (config) => ipcRenderer.send("hotkeys:set", config),
  /** Chamado quando um atalho global é apertado (mesmo com a janela em segundo plano). */
  onHotkey: (listener) => {
    const handler = (_event, action) => listener(action);
    ipcRenderer.on("hotkey", handler);
    return () => ipcRenderer.removeListener("hotkey", handler);
  },
});
