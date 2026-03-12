# RFD Authoring Guide

## Scope

These instructions apply to everything under `docs/rfds/`.

## Purpose

RFDs in this repository should explain architectural decisions for Poneglyph clearly enough that contributors can implement and challenge them.

## Authoring rules

- Follow the repository RFD template unless the user asks for a different structure.
- Anchor proposals in concrete invariants and system behavior.
- Distinguish clearly between facts as the source of truth, consolidated entities as derived state, projections as async secondary systems, and strongly consistent query paths.
- Call out unresolved questions explicitly instead of hiding them in prose.
- When relevant, mention how the proposed design differs from `crates/old-borg-memory`.

## Style

- Prefer precise language over exhaustive background.
- Use examples with realistic URIs and facts.
- Include operational consequences, not just data model descriptions.
- Keep future work in `Unresolved questions` or `Future possibilities`, not mixed into the core design.
