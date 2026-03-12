# UI Package Guide

## Scope

These instructions apply to `packages/ui/`.

## Purpose

- `packages/ui` is the shared component layer for Poneglyph frontend surfaces.
- It should provide design-system primitives and composable building blocks, not application feature logic.

## Working rules

- Prefer small, readable primitives over large kitchen-sink components.
- Keep styling intentional and distinctive; do not drift into generic default component-library aesthetics.
- Avoid importing Electron APIs or app runtime concerns into this package.
- When a component API grows app-specific branches, move that feature logic back into the app layer.
