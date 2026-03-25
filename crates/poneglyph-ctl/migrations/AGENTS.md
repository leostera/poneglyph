# Control Store Migrations Guide

## Scope

These instructions apply to `crates/poneglyph-ctl/migrations/`.

## Rules

1. Once a migration file is created, never modify it.
2. If a migration needs correction, create a new migration file with the next sequence number.
3. During local development (for example `cargo watch -- cargo run`), migrations are applied automatically as soon as they exist. If a migration was written incorrectly and already applied locally, do not edit it; add another migration that fixes it.

## Why

SQLx tracks applied migrations by checksum. Editing an existing migration causes startup failures such as: "migration N was previously applied but has been modified".
