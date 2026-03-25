import { contextBridge } from "electron";

const apiBaseUrl = process.env.PONEGLYPH_API_URL ?? "http://127.0.0.1:8787";

contextBridge.exposeInMainWorld("poneglyph", {
  platform: process.platform,
  version: process.versions.electron,
  apiBaseUrl,
});
