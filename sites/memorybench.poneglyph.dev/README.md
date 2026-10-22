# Poneglyph MemoryBench application

Work in progress; no benchmark scores or deployed endpoint yet. The application and benchmark adapter will use `https://memorybench.poneglyph.dev/mcp` with isolated hosted graphs. The authoritative contract is the [MemoryBench section of RFD0006](../../docs/rfds/RFD0006-public-read-only-mcp-playground.md#memorybench-mcp-application-2026-10-22).

## Reproduce the dataset audit (offline)

MemoryBench upstream is pinned at `063b86bfb347336def3a084153f40bfea1e2dfd6`:

```sh
node --import tsx sites/memorybench.poneglyph.dev/scripts/audit-datasets.ts \
  /path/to/locomo10.json /path/to/longmemeval_s_cleaned.json
```

Both files must match the hashes in [`evidence/datasets.json`](./evidence/datasets.json); malformed/partial or changed files fail closed. The script does not download data, call models, or contact Cloudflare. `textCharacters` counts JavaScript UTF-16 code units in raw message text, not tokens or normalized upstream content (for example, LoCoMo's photo captions are added upstream). Empty message strings are preserved, not dropped.

Sources:
- [LoCoMo](https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json) (bytes pinned by SHA-256).
- [LongMemEval-S cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json).
- [MemoryBench provider contract](https://github.com/supermemoryai/memorybench/blob/063b86bfb347336def3a084153f40bfea1e2dfd6/src/types/provider.ts).

The provider implements `initialize(config)`, `ingest(sessions, {containerTag})`, `awaitIndexing(result, containerTag, onProgress?)`, `search(query, {containerTag, limit?, threshold?})`, and `clear(containerTag)`. `ingest` returns document IDs and optional task IDs; `search` returns an array of context values. Upstream submits one session at a time and checkpoints completed session IDs. LoCoMo shares one container per conversation; LongMemEval uses one per question. Full counts are 1,986 and 500 questions respectively, per variant.

Upstream answer and judge OpenAI clients are configured in `src/orchestrator/phases/answer.ts` and `src/judges/openai.ts`; model definitions/defaults live in `src/utils/models.ts`. Both clients need explicit Cloudflare REST base URL/header configuration: a provider `baseUrl` alone does not route answering or judging. No ground-truth fields may reach the provider or retrieval model.
