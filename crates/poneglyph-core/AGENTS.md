# Poneglyph Core Guide

## Scope

These instructions apply to `crates/poneglyph-core/`.

## Purpose

- `poneglyph-core` defines the shared domain types used across the backend.
- Keep this crate small, dependency-light, and focused on portable data structures.

## Working rules

- Prefer typed errors with `thiserror` over unstructured error handling.
- Keep storage-specific codecs and persistence details out of this crate.
- Public API changes should be documented with rustdoc on the exported surface in `src/lib.rs`.
