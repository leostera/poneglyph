# App Guide

## Scope

These instructions apply to `app/`.

## Purpose

- `app/` is the desktop application shell.
- It owns the Electron main process, preload bridge, renderer app, and desktop packaging.

## Boundaries

- Keep daemon and storage logic out of `app/`. The app should talk to a runtime service, not reimplement it.
- Electron-specific lifecycle, menu bar behavior, window management, and local IPC belong here.
- Renderer features should live here unless they are broadly reusable UI primitives, in which case they belong in `packages/ui`.

## Structure

- `src/main/` contains Electron main-process entrypoints and native desktop behavior.
- `src/preload/` contains the narrow bridge exposed to the renderer.
- `src/renderer/` contains the React application and route modules.
- `resources/` contains unpacked runtime resources that should ship beside the app bundle, such as the future Rust daemon binary.

## Working rules

- Prefer small renderer features that are actually clickable over speculative abstractions.
- Keep preload APIs narrow and explicit.
- Keep the Rust daemon as the backend source of truth. The Electron app should supervise it and talk to it, not absorb its responsibilities.
- Preserve the existing visual direction unless the user asks to restyle it.
