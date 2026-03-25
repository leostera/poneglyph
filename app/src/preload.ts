import { ipcRenderer } from "electron";
import { contextBridge } from "electron";
import { IPC_CHANNELS } from "./constants";

const apiBaseUrl = process.env.PONEGLYPH_API_URL ?? "http://127.0.0.1:8787";

contextBridge.exposeInMainWorld("poneglyph", {
  apiBaseUrl,
});

window.addEventListener("message", (event) => {
  if (event.data === IPC_CHANNELS.START_ORPC_SERVER) {
    const [serverPort] = event.ports;

    ipcRenderer.postMessage(IPC_CHANNELS.START_ORPC_SERVER, null, [serverPort]);
  }
});
