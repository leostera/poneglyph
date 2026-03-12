# Packages Guide

## Scope

These instructions apply to `packages/` unless a deeper `AGENTS.md` overrides them.

## Purpose

- `packages/` contains shared frontend modules used by one or more apps.
- Keep packages narrow, reusable, and independent of Electron process concerns.

## Boundaries

- Shared design system primitives belong in `packages/ui`.
- Shared copy, locale data, and translation helpers belong in `packages/i18n`.
- App-specific screens, routes, and window behavior do not belong here.
