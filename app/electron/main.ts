import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, type NativeImage, Tray, app, nativeImage } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV !== "production";
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function createWindow() {
  if (mainWindow) {
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: "Poneglyph",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0d0b09",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("close", (event) => {
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    void mainWindow.loadURL("http://127.0.0.1:3000");
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return mainWindow;
  }

  void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  return mainWindow;
}

function showMainWindow() {
  const window = createWindow();
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

function toggleMainWindow() {
  const window = createWindow();
  if (window.isVisible() && window.isFocused()) {
    window.hide();
    return;
  }

  showMainWindow();
}

function createTrayIcon(): NativeImage {
  const svg = `
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <rect x="2.25" y="2.25" width="13.5" height="13.5" rx="3.5" fill="black"/>
      <path d="M6 5.5H9.5C12 5.5 13.75 7 13.75 9.15C13.75 11.35 12.05 12.85 9.45 12.85H8V14.5H6V5.5ZM8 7.3V11.05H9.3C10.85 11.05 11.7 10.35 11.7 9.2C11.7 8.05 10.85 7.3 9.3 7.3H8Z" fill="white"/>
    </svg>
  `;
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
  );
  image.setTemplateImage(true);
  return image.resize({ width: 18, height: 18 });
}

function createTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip("Poneglyph");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Poneglyph", click: () => showMainWindow() },
      {
        label: "Hide Window",
        click: () => {
          mainWindow?.hide();
        },
      },
      { type: "separator" },
      {
        label: "Quit Poneglyph",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => {
    toggleMainWindow();
  });
  return tray;
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
