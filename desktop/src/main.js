// Concord Hub para computador: o site numa janela própria.
// Como carrega o site no ar, toda atualização do site chega sozinha; o que mora aqui é só o que o navegador não faz:
// ícone na bandeja, atalhos globais, seletor de tela com som e abrir junto com o computador.
const path = require("node:path");
const { app, BrowserWindow, Menu, Tray, desktopCapturer, globalShortcut, ipcMain, nativeImage, session, shell } = require("electron");
const { parseHotkeyConfig } = require("./accelerator");

const APP_URL = process.env.CONCORD_URL || "https://concord-hub.duckdns.org";
const ORIGIN = new URL(APP_URL).origin;
const ICON = path.join(__dirname, "..", "build", "icon.png");
/** Logins externos que precisam abrir dentro da janela para o cookie voltar para o app. */
const LOGIN_HOSTS = new Set(["accounts.google.com", "github.com"]);
const ALLOWED_PERMISSIONS = new Set(["media", "notifications", "display-capture", "fullscreen", "clipboard-sanitized-write"]);

let win = null;
let tray = null;
let quitting = false;

const isHttps = (url) => {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};
const ownUrl = (url) => {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
};

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: "#08090c",
    title: "Concord Hub",
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.loadURL(APP_URL);

  // Links de fora do Concord abrem no navegador; o login com Google/GitHub fica na janela
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttps(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (ownUrl(url)) return;
    try {
      if (LOGIN_HOSTS.has(new URL(url).hostname)) return;
    } catch {
      // endereço inválido: bloqueia abaixo
    }
    event.preventDefault();
    if (isHttps(url)) void shell.openExternal(url);
  });

  // Fechar a janela só esconde (a chamada continua); "Sair" na bandeja encerra de verdade
  win.on("close", (event) => {
    if (quitting || process.platform === "darwin") return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    win = null;
  });
}

function createTray() {
  const image = nativeImage.createFromPath(ICON).resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.setToolTip("Concord Hub");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir o Concord Hub", click: showWindow },
      {
        label: "Abrir junto com o computador",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: "separator" },
      {
        label: "Sair",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", showWindow);
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      { role: "editMenu" },
      {
        label: "Exibir",
        submenu: [{ role: "reload", label: "Recarregar" }, { role: "resetZoom", label: "Zoom normal" }, { role: "zoomIn", label: "Aumentar" }, { role: "zoomOut", label: "Diminuir" }, { role: "togglefullscreen", label: "Tela cheia" }],
      },
      { role: "windowMenu" },
    ]),
  );
}

/** Só o Concord pode pedir microfone, câmera, notificação e tela. */
function setupPermissions() {
  const ses = session.defaultSession;
  const fromOurSite = (url) => ownUrl(url);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => callback(ALLOWED_PERMISSIONS.has(permission) && fromOurSite(details.requestingUrl)));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => ALLOWED_PERMISSIONS.has(permission) && fromOurSite(requestingOrigin));
}

/** Compartilhar tela: o Electron não tem seletor, então abrimos um com as telas e janelas (e som do sistema no Windows). */
function setupScreenShare() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
        const chosen = await pickSource(sources);
        if (!chosen) return callback({});
        callback({ video: chosen, audio: process.platform === "win32" ? "loopback" : undefined });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: true }, // no Mac mais novo o próprio sistema mostra o seletor
  );
}

let pickerResolve = null;
let pickerSources = [];
function pickSource(sources) {
  return new Promise((resolve) => {
    pickerSources = sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), screen: s.id.startsWith("screen:") }));
    pickerResolve = resolve;
    const picker = new BrowserWindow({
      parent: win ?? undefined,
      modal: !!win,
      width: 760,
      height: 520,
      title: "Compartilhar tela",
      backgroundColor: "#08090c",
      autoHideMenuBar: true,
      minimizable: false,
      maximizable: false,
      webPreferences: { preload: path.join(__dirname, "picker-preload.js"), contextIsolation: true, sandbox: true },
    });
    picker.removeMenu();
    picker.loadFile(path.join(__dirname, "picker.html"));
    picker.on("closed", () => {
      const done = pickerResolve;
      pickerResolve = null;
      if (done) done(null); // fechou sem escolher
    });
    picker.once("ready-to-show", () => picker.show());
    ipcMain.removeHandler("picker:list");
    ipcMain.handleOnce("picker:list", () => pickerSources);
    ipcMain.removeAllListeners("picker:choose");
    ipcMain.once("picker:choose", (_e, id) => {
      const chosen = sources.find((s) => s.id === id) ?? null;
      const done = pickerResolve;
      pickerResolve = null;
      if (done) done(chosen);
      if (!picker.isDestroyed()) picker.close();
    });
  });
}

/** Atalhos globais: valem com a janela em segundo plano (mutar no meio do jogo). */
function registerHotkeys(config) {
  globalShortcut.unregisterAll();
  for (const [action, accelerator] of parseHotkeyConfig(config)) {
    try {
      globalShortcut.register(accelerator, () => {
        if (win && !win.isDestroyed()) win.webContents.send("hotkey", action);
      });
    } catch {
      // atalho que o sistema não deixa registrar: segue sem ele
    }
  }
}

function setupIpc() {
  ipcMain.on("hotkeys:set", (event, config) => {
    // só o site do Concord pode mexer nos atalhos do computador
    if (!ownUrl(event.senderFrame?.url ?? "")) return;
    registerHotkeys(config);
  });
}

function setupUpdates() {
  // sem o arquivo app-update.yml (gerado só quando o instalador sai do GitHub Releases) não há de onde atualizar
  if (!app.isPackaged || !require("node:fs").existsSync(path.join(process.resourcesPath, "app-update.yml"))) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch {
    // sem atualização automática: o instalador novo resolve
  }
}

/** `CONCORD_SMOKE=1 electron .`: abre, confere que a ponte existe e fecha sozinho (para testar sem olhar a tela). */
function smokeTest() {
  if (!process.env.CONCORD_SMOKE) return;
  win.webContents.once("did-finish-load", async () => {
    try {
      const info = await win.webContents.executeJavaScript(
        "JSON.stringify({ title: document.title, bridge: typeof window.concordDesktop, platform: window.concordDesktop && window.concordDesktop.platform, setHotkeys: window.concordDesktop && typeof window.concordDesktop.setHotkeys })",
      );
      console.log(`SMOKE ${info}`);
    } catch (err) {
      console.log(`SMOKE erro ${err.message}`);
    }
    quitting = true;
    app.quit();
  });
  setTimeout(() => {
    console.log("SMOKE tempo esgotado");
    quitting = true;
    app.quit();
  }, 45_000);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(() => {
    buildMenu();
    setupPermissions();
    setupScreenShare();
    setupIpc();
    createWindow();
    createTray();
    setupUpdates();
    smokeTest();
    app.on("activate", showWindow);
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", () => {
    // fica na bandeja; "Sair" encerra
  });
}
