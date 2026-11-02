# ADR-0001: One Postgres with pgvector instead of a separate vector database

Status: Accepted · Date: 2026-11-02

## Context
The corpus is ~24 documents (~500–800 chunks). Retrieval must combine vector similarity, full-text search and a role filter.

## Options
1. Postgres + pgvector, everything in one SQL query.
2. Managed vector DB (Pinecone, Qdrant Cloud) + Postgres for metadata.

## Decision
Option 1. Role filtering, FTS and vectors live in one query; one connection string; free tier; the corpus is far below the point where pgvector struggles.

## Consequences
- No vector index at this size (exact scan) — see ADR-0004.
- No separate service to secure or pay for. Scaling beyond ~1M chunks would require revisiting.
