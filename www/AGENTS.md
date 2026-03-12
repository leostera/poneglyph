# Website Guide

## Scope

These instructions apply to `www/`.

## Purpose

- `www/` is the web/marketing/documentation surface, separate from the desktop app shell.
- It can move faster visually and structurally than the Electron app, but it should stay conceptually aligned with Poneglyph’s architecture.

## Working rules

- Treat `www/` as a product-facing website, not the daemon control surface.
- Shared primitives should still come from `packages/` when that reuse is real.
- Keep the website isolated from Electron-only code and assumptions.
