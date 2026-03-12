# App Guide

## Scope

These instructions apply to `app/`.

## Purpose

- `app/` is the desktop application shell.
- It owns the Electron main process, preload bridge, renderer app, and local app-specific scripts.

## Boundaries

- Keep daemon and storage logic out of `app/`. The app should talk to a runtime service, not reimplement it.
- Electron-specific lifecycle, menu bar behavior, window management, and local IPC belong here.
- Renderer features should live here unless they are broadly reusable UI primitives, in which case they belong in `packages/ui`.

## Working rules

- Prefer small renderer features that are actually clickable over speculative abstractions.
- Keep preload APIs narrow and explicit.
- Preserve the existing visual direction unless the user asks to restyle it.
