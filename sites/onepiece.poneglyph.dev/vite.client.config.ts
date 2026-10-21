import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { CLIENT_OUT_DIR } from "./build/client-assets.ts";

// Browser client only. The output is embedded into the Worker bundle by
// vite.config.ts; it is never uploaded as Workers static assets.
export default defineConfig({
  root: resolve(import.meta.dirname, "client"),
  publicDir: resolve(import.meta.dirname, "public"),
  plugins: [react(), tailwindcss()],
  build: { outDir: CLIENT_OUT_DIR, emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
