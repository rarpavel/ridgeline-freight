# CLAUDE.md — Ridgeline Freight RAG Assistant

Instructions for AI agents working in this repository. Read the linked docs before changing the area they cover; they are the source of truth.

## What this is
An MVP portfolio project: a RAG assistant over 24 synthetic DOCX documents of a fictional US logistics company. Next.js 16 (App Router, TypeScript strict) + Postgres/pgvector; hybrid retrieval with role filtering in SQL; streamed single-turn answers with validated `[n]` citations; evaluation CLI with an independent judge. Spec: `docs/SPEC.md` (v3). Scope is deliberately small; the roadmap is in `docs/SPEC.md §13` — do not build roadmap items unless asked.

## Stack and commands
- pnpm, Node ≥ 22, TypeScript strict, Tailwind CSS + shadcn/ui (`src/components/ui`, add primitives with `pnpm dlx shadcn@latest add <name>`), Drizzle ORM, `openai` client (`OPENAI_BASE_URL` configurable), `iron-session`, `pino`, `vitest`, `mammoth`, `docx`.
- `pnpm dev` · `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm test:integration` (needs `docker compose up -d`)
- `pnpm db:generate` / `pnpm db:migrate` (uses `DATABASE_URL_DIRECT`) · `pnpm ingest [--force] [--only <slug>]` · `pnpm eval --split test|dev [--no-judge]` · `pnpm eval:import` · `pnpm datagen:*`
- Local DB: `docker compose up -d` (pgvector/pgvector:pg17, db `ridgeline`). Env: copy `.env.example` → `.env.local`.

## Where things are
- `src/app` routes/pages · `src/server/{db,ingest,rag,llm,auth,guardrails,prompts,eval}` server-only code · `src/lib` pure helpers · `scripts/` CLIs · `prompts/` versioned runtime prompts · `data-gen/` generation prompts, schemas, blocklist · `data/` world, registry, catalog, corpus, eval questions, VERSION · `drizzle/` migrations · `tests/{unit,integration}`.
- Docs: `docs/01-product/PRD.md`, `docs/02-architecture/ARCHITECTURE.md` + `adr/`, `docs/03-data/{DATA_MODEL,SYNTHETIC_DATA}.md`, `docs/04-ai/{RAG_PIPELINE,PROMPTS,EVALUATION}.md`, `docs/05-engineering/{CONVENTIONS,TESTING,WORKFLOW}.md`, `docs/06-ops/{SECURITY,DEPLOYMENT,OBSERVABILITY}.md`, `docs/07-portfolio/CASE_STUDY.md`.

## Rules that are easy to break
1. Role filtering happens in SQL (`access_roles && $roles`) in every chunk/document query, never in prompts or in JS after the fact. `tests/integration/rbac-leak.test.ts` must stay green.
2. Embeddings: one column `chunks.embedding vector(1536)` with `embedding_model`; one model (`text-embedding-3-small`); no vector index (exact scan is fine at this size).
3. Citations are per-request aliases `[1..n]`, validated server-side; refusals start with `NO_ANSWER:`; an answer with zero valid citations becomes a refusal.
4. Prompts are versioned files `prompts/<name>.v<N>.md`; never edit a version in place, add `v<N+1>`.
5. No long-running work in Vercel routes: ingestion and eval are CLIs. `/admin/eval` is read-only.
6. Auth is checked in `proxy.ts` **and** in each handler (`requireSession`/`requireRole`).
7. Server code imports `server-only`; secrets only via `src/env.ts`; never log keys, cookies or full prompts.
8. Every new dependency needs a one-line justification in the PR. Prefer the versions in `docs/00-review/SPEC_REVIEW.md §7`.
9. Tests per `docs/05-engineering/TESTING.md`; a PR is done only with the Definition of Done in `docs/05-engineering/WORKFLOW.md`.
10. Single-turn chat: no history is sent or stored.

## Workflow
Tasks are in Notion (Tasks DB, ordered by `Order`). One branch per task (`rag-012-slug`), Conventional Commits, squash-merge, `main` always deployable. Update the `Last updated` line of any doc you change.
