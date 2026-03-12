# i18n Package Guide

## Scope

These instructions apply to `packages/i18n/`.

## Purpose

- `packages/i18n` holds shared messages, locale data, and translation-facing helpers.

## Working rules

- Keep message keys stable and grouped by feature or surface.
- Prefer explicit message objects over clever runtime indirection until real localization needs justify it.
- Do not mix visual presentation concerns into this package.
