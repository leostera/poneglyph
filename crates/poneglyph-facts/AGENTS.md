# Poneglyph Facts Guide

## Scope

These instructions apply to `crates/poneglyph-facts/`.

## Purpose

- `poneglyph-facts` owns append-only fact storage and retrieval.
- This crate may depend on storage and serialization details that do not belong in `poneglyph-core`.

## Working rules

- Keep the store API stream-first.
- Preserve append-only semantics across all backends.
- Treat serialization and database codecs as storage-edge concerns local to this crate.
