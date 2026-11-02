# ADR-0018: Chunker v2 lowers the minimum chunk size to 50 tokens

Status: Accepted · Date: 2026-11-02

## Context
RAG-020 expects 400–900 chunks on the corpus. Chunker v1 (ADR-0017, 120-token minimum) gives 217, and the corpus holds only about 39k tokens, so 400 chunks means a mean below 100 tokens. The project owner chose to retune the chunker now rather than change the criterion, ahead of the tuning planned for RAG-033.

Measured on the corpus, by minimum size:

| Minimum | Chunks | Mean tokens |
|---------|--------|-------------|
| 120 | 217 | 175 |
| 60 | 363 | 108 |
| 50 | 423 | 93 |
| 40 | 486 | 81 |
| 20 | 545 | 72 |

## Decision
- `MIN_CHUNK_TOKENS` is 50, the largest tried value that reaches 400 chunks. `CHUNKER_VERSION` is `v2`, so the next `pnpm ingest` rebuilds every document.
- The limit for keeping a table whole stays at 1,080 tokens. It no longer derives from the minimum, so this change does not affect tables.
- The merge rules from ADR-0017 are unchanged. This replaces its 120-token minimum and its figures for chunk size.

## Consequences
- 423 chunks, mean 93 tokens, 14–25 per contract, policy or SOP. Citations point to a narrower range of text.
- This moves further from the 300–600 target in `SPEC.md`, and the 120–600 size in RAG-019 no longer holds.
- `finalK = 8` now puts about 750 tokens of context in a prompt instead of about 1,400, which may lower correctness on questions that need several clauses. This has not been measured: RAG-033 should tune chunk size and `finalK` together on the dev split.
- The margin above 400 is small, so a later change to the chunker or corpus can fall below it. A unit test fails if the count leaves 400–900.
- Any environment already indexed with v1 re-embeds in full on its next ingest.
