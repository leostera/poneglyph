import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: path.resolve(appRoot, "src/renderer"),
    envDir: workspaceRoot,
    plugins: [react()],
    resolve: {
      alias: [
        {
          find: "@poneglyph/ui/styles.css",
          replacement: fileURLToPath(new URL("../packages/ui/src/styles.css", import.meta.url)),
        },
        {
          find: "@poneglyph/ui",
          replacement: fileURLToPath(new URL("../packages/ui/src/index.ts", import.meta.url)),
        },
        {
          find: "@poneglyph/i18n",
          replacement: fileURLToPath(new URL("../packages/i18n/src/index.ts", import.meta.url)),
        },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 3000,
    },
  },
});
