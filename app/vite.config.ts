import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
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
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 3000,
  },
  envDir: rootDir,
});
