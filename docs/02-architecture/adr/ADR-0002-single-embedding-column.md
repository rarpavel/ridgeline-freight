# ADR-0002: One embedding column, one model (text-embedding-3-small, 1536)

Status: Accepted · Date: 2026-11-02

## Context
v2 planned a per-model `chunk_embeddings` table with 1024-d vectors to support switching to `bge-m3`. The MVP drops the local-model switch (SPEC v3 §12).

## Options
1. Per-model table + `dimensions: 1024` (v2 design).
2. One column `chunks.embedding vector(1536)` + `embedding_model` text; one model.

## Decision
Option 2. Fewer tables, no partial indexes, no dimension shortening. `embedding_model` is recorded so a future switch is detectable, and the `openai` client keeps a configurable `baseURL`.

## Consequences
- Switching to a model with another dimension needs a migration and a full re-embed (documented in `DATA_MODEL.md §6`).
- The v2 design stays in the roadmap and in `SPEC_REVIEW.md` F-01 if local models return.
