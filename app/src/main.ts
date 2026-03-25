import fs from "node:fs";
import path from "node:path";
import { ipcContext } from "@/ipc/context";
import { BrowserWindow, app, nativeImage } from "electron";
import { REACT_DEVELOPER_TOOLS, installExtension } from "electron-devtools-installer";
import { ipcMain } from "electron/main";
import { UpdateSourceType, updateElectronApp } from "update-electron-app";
import { IPC_CHANNELS, inDevelopment } from "./constants";
import { getBasePath } from "./utils/path";

const inEndToEndTest = process.env.CI === "e2e" || process.env.PONEGLYPH_E2E === "true";

const remoteDebuggingPort =
  process.env.PONEGLYPH_ELECTRON_REMOTE_DEBUGGING_PORT ?? (inDevelopment ? "9222" : undefined);

if (remoteDebuggingPort) {
  app.commandLine.appendSwitch("remote-debugging-port", remoteDebuggingPort);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

const DEFAULT_WINDOW_BOUNDS = {
  width: 1440,
  height: 960,
};

type PersistedWindowBounds = {
  height: number;
  width: number;
  x?: number;
  y?: number;
};

function firstExistingPath(candidates: string[]) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveIconAsset(basePath: string, fileName: string) {
  return firstExistingPath([
    path.resolve(basePath, "../../../assets", fileName),
    path.resolve(basePath, "../../assets", fileName),
    path.resolve(basePath, "../assets", fileName),
    path.resolve(process.cwd(), "../assets", fileName),
    path.resolve(process.cwd(), "assets", fileName),
  ]);
}

function resolveWindowIcon(basePath: string) {
  const svgIconPath = resolveIconAsset(basePath, "poneglyph.svg");
  const pngIconPath = resolveIconAsset(basePath, "poneglyph.png");

  if (svgIconPath) {
    const iconFromSvg = nativeImage.createFromPath(svgIconPath);
    if (!iconFromSvg.isEmpty()) {
      return iconFromSvg;
    }
  }

  if (pngIconPath) {
    const iconFromPng = nativeImage.createFromPath(pngIconPath);
    if (!iconFromPng.isEmpty()) {
      return iconFromPng;
    }
  }

  return undefined;
}

function getWindowStatePath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState(): PersistedWindowBounds {
  try {
    const saved = JSON.parse(
      fs.readFileSync(getWindowStatePath(), "utf8"),
    ) as Partial<PersistedWindowBounds>;

    return {
      height: typeof saved.height === "number" ? saved.height : DEFAULT_WINDOW_BOUNDS.height,
      width: typeof saved.width === "number" ? saved.width : DEFAULT_WINDOW_BOUNDS.width,
      x: typeof saved.x === "number" ? saved.x : undefined,
      y: typeof saved.y === "number" ? saved.y : undefined,
    };
  } catch {
    return DEFAULT_WINDOW_BOUNDS;
  }
}

function persistWindowState(mainWindow: BrowserWindow) {
  try {
    const bounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();

    fs.writeFileSync(getWindowStatePath(), JSON.stringify(bounds, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to persist window state:", error);
  }
}

function createWindow() {
  const basePath = getBasePath();
  const preload = path.join(basePath, "preload.js");
  const windowIcon = resolveWindowIcon(basePath);
  const initialBounds = loadWindowState();
  const mainWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    x: initialBounds.x,
    y: initialBounds.y,
    title: "Poneglyph",
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      devTools: inDevelopment,
      contextIsolation: true,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: false,

      preload,
    },
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 14 } : undefined,
  });
  ipcContext.setMainWindow(mainWindow);
  mainWindow.on("close", () => {
    persistWindowState(mainWindow);
  });
  mainWindow.on("move", () => {
    persistWindowState(mainWindow);
  });
  mainWindow.on("resize", () => {
    persistWindowState(mainWindow);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(basePath, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  if (inDevelopment && process.env.PONEGLYPH_OPEN_DEVTOOLS !== "false") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

async function installExtensions() {
  try {
    const result = await installExtension(REACT_DEVELOPER_TOOLS);
    console.log(`Extensions installed successfully: ${result.name}`);
  } catch {
    console.error("Failed to install extensions");
  }
}

function checkForUpdates() {
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: "LuanRoger/electron-shadcn",
    },
  });
}

async function setupORPC() {
  const { rpcHandler } = await import("./ipc/handler");

  ipcMain.on(IPC_CHANNELS.START_ORPC_SERVER, (event) => {
    const [serverPort] = event.ports;

    serverPort.start();
    rpcHandler.upgrade(serverPort);
  });
}

app.whenReady().then(async () => {
  try {
    app.setName("Poneglyph");
    if (process.platform === "darwin") {
      const dockIcon = resolveWindowIcon(getBasePath());
      if (dockIcon) {
        app.dock?.setIcon(dockIcon);
      }
    }
    createWindow();
    if (!inEndToEndTest) {
      await installExtensions();
      checkForUpdates();
    }
    await setupORPC();
  } catch (error) {
    console.error("Error during app initialization:", error);
  }
});

//osX only
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
//osX only ends
