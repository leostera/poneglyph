# Poneglyph Consolidation Guide

## Scope

These instructions apply to `crates/poneglyph-consolidation/`.

## Purpose

- `poneglyph-consolidation` turns append-only facts into deterministic entity views.
- Keep consolidation pure and replay-friendly.

## Working rules

- Prefer deterministic ordering rules over implicit iteration order.
- Keep identity merging and authority weighting out until explicitly implemented.
- Use `poneglyph-core` types for public inputs and outputs.
