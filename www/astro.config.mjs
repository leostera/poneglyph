import { fileURLToPath } from "node:url";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

const isCloudflareBuild = process.env.CLOUDFLARE === "true";

export default defineConfig({
  integrations: [react()],
  vite: {
    resolve: {
      alias: [
        {
          find: "@poneglyph/ui",
          replacement: fileURLToPath(new URL("../packages/ui/src/index.ts", import.meta.url)),
        },
      ],
    },
  },
  output: isCloudflareBuild ? "server" : "static",
  adapter: isCloudflareBuild
    ? cloudflare({
        platformProxy: {
          enabled: false,
        },
      })
    : undefined,
  server: {
    host: true,
  },
});
