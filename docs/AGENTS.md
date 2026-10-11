# Documentation Guide

## Scope

These instructions apply to everything under `docs/` unless a deeper `AGENTS.md` overrides them.

## Expectations

- Keep documentation concrete and implementation-oriented.
- Prefer recording decisions, invariants, and tradeoffs over aspirational marketing language.
- When describing architecture, separate source-of-truth state from derived views and operational concerns.

## File placement

- Reflect substantive architecture, API, operations, and validation content in the relevant existing RFDs under `docs/rfds/`; preserve historical status and evidence limitations.
- Do not create a new RFD merely to move a standalone guide; integrate the content into existing records.
- RFDs are authoritative for design decisions and contracts. README.md files may retain useful orientation, explanations, and quick starts with links to the relevant RFDs, but must not become competing authoritative design records. Other Markdown outside `docs/rfds/` must be standard repository files such as AGENTS.md, CONTRIBUTING.md, or HACKING.md, not standalone topic guides.

## Maintenance

- If code or process changes make a doc misleading, update the doc in the same change when practical.
- Avoid copying large blocks from other docs; link or reference the canonical file instead.
