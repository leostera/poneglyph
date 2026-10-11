# Write-path results — clean 100k iteration

The user requested stopping the earlier experiments, deleting all generated results, and restarting with **the same 100,000 corpus facts per concurrent scenario**. Earlier report directories, feasibility JSON, Worker archives, raw response journals, SQLite trial states, and logs were removed. Git history was not rewritten. The prepared corpus inputs and harness were retained.

The new matrix is:

| Facts/call | Concurrent logical calls | Planned calls | Facts per case |
| ---: | ---: | ---: | ---: |
| 100 | 10 | 1,000 | 100,000 |
| 10 | 100 | 10,000 | 100,000 |
| 10 | 1,000 | 10,000 | 100,000 |
| 2 | 10,000 | 50,000 | 100,000 |

Each trial uses fresh SQLite storage and one graph, through the ordinary application Worker → packaged client → database Worker path. The database is unchanged. Failed requests are not resized, skipped, moved to another graph, or retried through a fallback API. Input feasibility checks are not persisted-write evidence.

New runs save manifests, per-case metrics, compressed outcome journals, Worker bundles, quiescent fact/index audits, and restart audits here. Bulk input snapshots, reference ledgers, and SQLite state stay in ignored `.data/runs/`. Partial/incomplete cases must be labeled as such.

Miniflare results establish local correctness/debugging evidence, **not Cloudflare throughput**. No cloud deployment or performance result is claimed by this reset.

Scale to 1M only after repeated matched comparisons show a better design without missing acknowledged writes, duplicates, partial transactions, broken indices, or recovery regressions. A fast failed load is not a successful throughput winner. The 100k iteration does not test the baseline's 100,000-outcome retention limit: its largest case needs 50,000 transactions; the 1M two-fact case needs 500,000.
