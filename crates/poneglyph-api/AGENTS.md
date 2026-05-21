# Poneglyph API Guide

## Scope

These instructions apply to `crates/poneglyph-api/`.

## Purpose

- `poneglyph-api` owns the local tonic/prost gRPC boundary for embedders that want a daemon service.
- Keep generated protobuf types, service adapters, and transport-facing validation here.
- Treat typed protobuf RPCs as the primary semantic API; legacy JSON RPCs are compatibility shims only.

## Working rules

- Prefer typed protobuf messages for stable fact, schema, entity, search, and query boundaries.
- Keep compatibility handlers sharing retrieval and validation helpers with typed handlers until the JSON shims are removed.
- Preserve append-only fact semantics across RPCs. Retractions append facts; they do not mutate or delete assertions.
- Avoid putting graph semantics here when they belong in `poneglyph-core`.
