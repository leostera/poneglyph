import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("poneglyph", {
  platform: process.platform,
  version: process.versions.electron,
});
