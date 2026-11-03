# ADR-0004: Hybrid retrieval with RRF and exact vector scan; refusal gate on similarity and citations

Status: Accepted, FTS query and gate signal replaced by ADR-0019 · Date: 2026-11-02

## Context
RRF scores depend only on ranks and cannot drive a refusal threshold. At ~700 chunks a vector index is unnecessary and filtered HNSW would lose recall by post-filtering.

## Decision
- Vector top-20 by exact cosine scan (no index) + FTS top-20 (`websearch_to_tsquery`, `ts_rank_cd`), role filter in both.
- RRF with k = 60 → top-8, at most 3 chunks per document.
- Gate: refuse without a model call only if best cosine < `SIM_FLOOR` **and** FTS returned nothing. Otherwise the model answers or refuses with `NO_ANSWER:`; an answer with zero valid citations becomes a refusal.
- `SIM_FLOOR` calibrated on the dev split.

## Consequences
- Three independent refusal signals; thresholds are measured, not guessed.
- Add HNSW with `hnsw.iterative_scan` (pgvector ≥ 0.8) only if the corpus grows ~50x; the recipe is in `SPEC_REVIEW.md` F-02.
