# Integrations TODO

This file tracks connector integrations we want in Poneglyph and the repeatable playbook to build them.

## Status legend
- `[ ]` not started
- `[-]` in progress
- `[x]` implemented

## Current connectors
- `[x]` Plex
- `[x]` Google Calendar
- `[x]` Gmail
- `[ ]` File System

## Backlog (requested)
### Communication & Messaging
- `[ ]` Slack
- `[ ]` Discord
- `[ ]` Apple Messages
- `[ ]` WhatsApp
- `[ ]` Telegram
- `[ ]` Signal

### Email
- `[ ]` Email (IMAP/POP3/SMTP generic)

### Code & Work
- `[ ]` GitHub
- `[ ]` Linear
- `[ ]` ChatGPT

### Storage & Databases
- `[ ]` S3 / MinIO / Hetzner / Cloudflare R2 (object storage family)
- `[ ]` Google Drive
- `[ ]` Postgres
- `[ ]` SQLite
- `[ ]` File System
- `[ ]` iCloud

### Browser & Knowledge
- `[ ]` Browser History (Chrome-first)
- `[ ]` Obsidian

### Social
- `[ ]` LinkedIn
- `[ ]` X (Twitter)
- `[ ]` Instagram
- `[ ]` TikTok
- `[ ]` Facebook
- `[ ]` YouTube
- `[ ]` Reddit
- `[ ]` Substack
- `[ ]` BlueSky
- `[ ]` Threads

### Media & Entertainment
- `[ ]` Spotify
- `[ ]` Netflix
- `[ ]` Crunchyroll
- `[ ]` Adobe Lightroom

### Health & Fitness
- `[ ]` Strava
- `[ ]` Withings
- `[ ]` Apple Fitness / Health
- `[ ]` Duolingo

### Finance & Commerce
- `[ ]` Wise
- `[ ]` Raiffeisen
- `[ ]` Airbnb
- `[ ]` Alza

### Infra / Network / Domains
- `[ ]` Cloudflare
- `[ ]` Name.com
- `[ ]` Unifi / Ubiquiti

## Integration playbook

## 1) Define connector model
- Pick provider key (`gmail`, `gcal`, `plex`, `github`, etc.).
- Define provider-specific uniqueness key for instances (for dedupe).
- Define instance shape (account/server/db/etc.).
- Define resources under instance (mailboxes/calendars/repos/libraries/etc.).
- Define core entity kinds and IDs (`ns:kind:id`) and stable key fields.

## 2) Schema + ingestion contract
- Add namespace/kind/field schema facts in connector `schema.rs`.
- Ensure ingestors resolve canonical entity URIs via search on key fields (avoid naive re-randomization).
- Write mapping for source -> facts with append-only semantics.
- Include enough fields for display views (`schema:name`, descriptions, time fields, links, status).

## 3) Control store + migrations
- Add tables/state to `crates/poneglyph-ctl` store.
- Create new migration file only (never edit old migrations).
- Add store methods for CRUD + sync state + dedupe checks.
- Add tests for store behavior and migration expectations.

## 4) Connector runtime wiring
- Create connector module in `crates/poneglyph-ctl/src/connectors/<provider>/`.
- Implement `run(tx)` to stream fact batches through runtime bridge.
- Implement bootstrap/discovery flows where needed.
- Ensure failures are isolated (connector errors do not crash daemon).

## 5) API surface
- Add service methods in `crates/poneglyph-api/src/services/<provider>.rs`.
- Add GraphQL query/mutation fields in `graphql/schema.rs`.
- Update `build.rs` / `schema.graphql`.
- Keep auth flows under `/auth/:provider/*` where applicable.

## 6) App flows
- Add provider entry to connector catalog.
- Add onboarding flow (connect -> discover/select resources -> done).
- Add provider detail page (instances/resources/sync/logs/actions).
- Add entity list/detail specialized views if useful.

## 7) Testing checklist
- Unit tests:
  - parser/client/ingestor/store
  - dedupe/uniqueness behavior
  - sync state transitions
- API tests:
  - GraphQL queries/mutations
  - auth callbacks/handoff if OAuth
- Runtime tests:
  - connector errors do not kill runtime
  - fact streaming works end-to-end
- E2E (app):
  - add connector flow
  - provider detail navigation
  - resource selection updates

## 8) Logging & safety
- No secrets in logs (tokens/secrets always redacted).
- Keep dependency logs quiet by default.
- Use explicit `info!/debug!` for crate-owned logs.

## 9) Done criteria
- Connector instance can be created from app UI.
- Resources can be discovered/selected from app UI.
- Sync produces entities visible in Knowledge Graph.
- Re-sync is idempotent and deduplicated.
- Tests pass (`cargo test`, app checks, and e2e where present).

## Suggested implementation order (high leverage first)
- `[ ]` File System
- `[ ]` Spotify
- `[ ]` Postgres
- `[ ]` SQLite
- `[ ]` GitHub
- `[ ]` Telegram
- `[ ]` Google Drive
- `[ ]` Slack
