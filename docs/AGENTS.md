# Documentation Guide

## Scope

These instructions apply to everything under `docs/` unless a deeper `AGENTS.md` overrides them.

## Expectations

- Keep documentation concrete and implementation-oriented.
- Prefer recording decisions, invariants, and tradeoffs over aspirational marketing language.
- When describing architecture, separate source-of-truth state from derived views and operational concerns.

## File placement

- Put design proposals and architecture decisions in `docs/rfds/`.
- Keep general documentation in `docs/` focused on orientation, concepts, and operator/developer guidance.

## Maintenance

- If code or process changes make a doc misleading, update the doc in the same change when practical.
- Avoid copying large blocks from other docs; link or reference the canonical file instead.
