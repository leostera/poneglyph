import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [cloudflare()],
  // Don't resolve localhost onto an unrelated IPv4/IPv6 dev server. Seeding
  // must address this exact owned loopback listener or fail before any write.
  server: mode === "seed" ? { host: "127.0.0.1", port: 8878, strictPort: true } : undefined,
}));
