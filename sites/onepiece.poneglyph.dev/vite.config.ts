import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  // The browser app (index.html → src/app) is built as static assets served
  // by the Worker; the loopback seed operator has no client.
  plugins: mode === "seed" ? [cloudflare()] : [react(), tailwindcss(), cloudflare()],
  // Don't resolve localhost onto an unrelated IPv4/IPv6 dev server. Seeding
  // must address this exact owned loopback listener or fail before any write.
  server: mode === "seed" ? { host: "127.0.0.1", port: 8878, strictPort: true } : undefined,
}));
