import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
export default defineConfig(({ mode }) => ({
  plugins: [cloudflare()], publicDir: false,
  server: mode === "operator" ? { host: "127.0.0.1", port: 8880, strictPort: true } : undefined,
}));
