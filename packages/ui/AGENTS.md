# UI Package Guide

## Scope

These instructions apply to `packages/ui/`.

## Purpose

- `packages/ui` is the shared design system for the desktop app.
- It owns reusable primitives, shell-level composition pieces, tokens, and Storybook coverage.

## Boundaries

- Reusable components and visual language belong here.
- App-specific screens, mocked datasets, and Electron behavior do not belong here.
- Keep compatibility exports stable while `app/` is still iterating quickly.

## Working rules

- Prefer dense defaults and consistent rhythm over large decorative components.
- Add or update Storybook stories when you change exported primitives.
- Keep `src/index.ts` and `src/styles.css` as the stable public surface consumed by `app/`.
