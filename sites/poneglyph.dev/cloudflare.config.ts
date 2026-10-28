import { defineConfig } from "cf/config";

// Public landing page for Poneglyph: an assets-only Worker (no script), so
// unknown paths get public/404.html. The name reuses the existing apex Worker
// so its version history keeps a rollback path.
export default defineConfig({
  worker: {
    name: "poneglyph-www",
    compatibilityDate: "2026-10-13",
    workersDev: false,
    previewUrls: false,
    domains: ["poneglyph.dev"],
    assets: { notFoundHandling: "404-page", htmlHandling: "auto-trailing-slash" },
    observability: { enabled: true, logs: { enabled: true } },
  },
});
