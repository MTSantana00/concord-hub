import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyAppearance, loadAppearance } from "./appearance";
import { installAudioUnlock } from "./sounds";
import "./styles.css";

// Aplica o visual escolhido antes de desenhar a tela, para não piscar no tema errado
applyAppearance(loadAppearance());
// Os avisos sonoros só tocam se o navegador já liberou o áudio num toque da pessoa
installAudioUnlock();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// App instalável: registra o service worker mínimo (só na versão publicada)
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // sem service worker o site funciona igual; só não aparece a opção de instalar
    });
  });
}
