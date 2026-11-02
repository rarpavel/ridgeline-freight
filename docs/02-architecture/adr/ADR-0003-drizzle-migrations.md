# ADR-0003: Drizzle ORM with drizzle-kit SQL migrations

Status: Accepted · Date: 2026-11-02

## Context
We need typed DB access from Next.js and CLIs, SQL migrations that can run in CI and against Neon, and support for `vector` and generated `tsvector` columns.

## Options
1. Drizzle ORM + drizzle-kit (SQL migration files, `vector` type supported, custom SQL for extension and generated columns).
2. Prisma (pgvector via `Unsupported`, heavier runtime).
3. Raw SQL files + `node-pg-migrate` and hand-written types.

## Decision
Option 1. Thin, SQL-first, pgvector helpers (`cosineDistance`), migrations are plain SQL we can read in a PR.

## Consequences
- `CREATE EXTENSION vector`, the generated `tsv` column and CHECK constraints are written in custom migrations (`drizzle-kit generate --custom`).
- Migrations run with the direct (non-pooled) Neon URL.
