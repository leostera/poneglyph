import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import { CLIENT_ASSETS_MODULE, clientAssetsModule } from "./build/client-assets.ts";

function embedClient(): Plugin {
  const resolved = `\0${CLIENT_ASSETS_MODULE}`;
  return {
    name: "playground-embed-client",
    resolveId: id => (id === CLIENT_ASSETS_MODULE ? resolved : undefined),
    load: id => (id === resolved ? clientAssetsModule() : undefined),
  };
}

export default defineConfig(({ mode }) => ({
  // Worker only. Build the client first (`vite build -c vite.client.config.ts`);
  // the seed operator has no client.
  plugins: mode === "seed" ? [cloudflare()] : [embedClient(), cloudflare()],
  // public/ belongs to the embedded client; nothing is uploaded as static assets.
  publicDir: false,
  // Don't resolve localhost onto an unrelated IPv4/IPv6 dev server. Seeding
  // must address this exact owned loopback listener or fail before any write.
  server: mode === "seed" ? { host: "127.0.0.1", port: 8878, strictPort: true } : undefined,
}));
