# Direct authenticated hosted read smoke

Run `977553d8-00ed-47f9-81c9-df88ef2e34d3`: **96/96 complete correct answers**, zero query retries/fact writes, observed backend version `b45f2acb-b6fc-4a75-b434-9a3a58b9ea73` equal before/after. **Latency target failed**: compound /8 native/service p99 333/327 ms; all-outcome caller p99 447.72 ms. Both serial 16-call phases retain their first cold miss, not just warm results.

- Original report, settled phase files, plan and original hashes are preserved byte-for-byte. `scope.json` distinguishes evidence from limitations and includes all phase summaries.
- The historical harness worktree was dirty. Its full exact snapshot was **not retained**; this is not a clean-source-certified run. Operator source matches Git `c97efb6`; the preview child matches the committed shared child. The archived compiled input bundle matches its original hash.
- Historical `operatorBundleSha256` denotes the **pre-Wrangler input**, not the final hosted probe. Startup colo/control CLI version were not captured then. Do not infer placement.
- The stable deployed backend predates the new replicated read-head integration; this run **does not measure that architecture**.
- Root check/build and ten warm/cold focused controls passed before subsequent diagnostic/provenance and test-only changes. The final 31-test Worker log includes reader-first empty-head non-authorization, later parent admission and real native-RPC publication/validation/retirement controls. These are local tests, not cloud scaling or full-tier certification.
- Subsequent 10,000-call baseline attempts stopped during deployment-metadata lookup with **zero graph queries**; independent Node HTTPS and curl checks confirmed connection refusal. They are not successful capacity rounds. No read-head deployment/opt-in occurred.

Private preview config/logs, URLs, credentials and auth headers are excluded. `checksums.json` hashes the retained files (excluding itself).

Authoritative architecture and validation scope: [RFD0004](../../../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md).
