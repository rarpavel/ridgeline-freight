# Testing Strategy

What is tested at which level, with which tools, and what runs in CI. The goal is confidence in retrieval, access control and citations, not coverage numbers.

Last updated: 2026-11-02

## 1. Levels

| Level | Tool | Runs | Needs | Scope |
|-------|------|------|-------|-------|
| Unit | `vitest` | `pnpm test`, every CI job | nothing | pure functions: chunker, RRF, gate, citation parsing, SSE encoding, prompt loading/rendering, env parsing, markdown sanitizer, pricing, DOCX parser on fixtures |
| Integration | `vitest` + Postgres container | `pnpm test:integration`, CI | Docker `pgvector/pgvector:pg17`, fake embedder | migrations, ingest pipeline on fixture documents, retrieval SQL (role filter), rate limiter, budget stop, auth routes, traces, **RBAC leak test** |
| Eval | eval CLI | manual before each milestone | real API keys | retrieval/answer quality (`EVALUATION.md`) |
| Smoke (prod) | manual `curl` + one question per role | after each production deploy | — | `/api/health`, login, chat, viewer, show-sources |

## 2. What is tested where

### Unit (`tests/unit/`)
- `chunker`: sizes within 120–600 tokens, section refs, offsets map back to the source text, tables kept whole, deterministic (`CHUNKER_VERSION`).
- `fuse`: RRF ordering, per-document cap, tie handling.
- `gate`: refusal only when both signals are weak; vector-unavailable path.
- `citations`: alias parsing, unknown alias removal, `NO_ANSWER:` detection, zero-citation → refusal conversion, text otherwise intact.
- `prompts`: loader hash stability, `{{var}}` rendering, missing variable throws; `prompts/rag-system.v1.md` equals the block in `data-gen/prompts/05-rag-system-prompt.md`.
- `markdown`: rendered answers contain no raw HTML, no links, no images.
- `docx parser` (fixtures in `tests/fixtures/*.docx`, produced by the data-gen renderer): headings → `##`, tables → Markdown rows, lists.
- `pricing`: cost math with `asOf`.

### Integration (`tests/integration/`, `globalSetup` starts/uses the Postgres container)
- `migrations.test.ts`: fresh DB → all migrations apply → schema matches Drizzle.
- `ingest.test.ts`: ingest 3 fixture documents with a deterministic fake embedder (hash → vector) → counts, idempotency (second run skips), `--force` re-embeds.
- `retrieval.test.ts`: role filter returns only allowed documents for each role; FTS zero-match path; vector-unavailable fallback.
- `rbac-leak.test.ts`: with the full demo corpus ingested (fake embedder), for every eval question and every role, no returned document outside `access_roles`; `other_role` questions return zero chunks. **This test must stay green forever.**
- `guardrails.test.ts`: 21st request in an hour → 429; daily budget reached → 503; windows reset.
- `auth.test.ts`: wrong password → 401 and counted by the limiter; cookie attributes; `/admin/*` forbidden for non-admin.
- `trace.test.ts`: one trace per request with correct counts.

## 3. Fixtures and determinism

- `tests/fixtures/`: 3 small DOCX files produced by the data-gen renderer from 1-page Markdown; committed.
- Fake embedder: `fakeEmbed(text) → vector(1536)` from a seeded hash, so retrieval tests are deterministic without API keys.
- LLM calls go through an injected `llm` dependency; no network in `pnpm test` or `pnpm test:integration`.

## 4. CI (`ci.yml`)

One workflow (`.github/workflows/ci.yml`, job `ci`) on every PR and every push to `main`: `typecheck` → `lint` → `test` → `test:integration`, on Node 22 with the pnpm store cached. Integration tests run against a `pgvector/pgvector:pg17` service container and read `DATABASE_URL` from the step's env; `globalSetup` waits up to 30 s for `SELECT 1`. No secrets required. Merge a PR only when it is green. GitHub does not enforce this yet: branch protection needs a public repository or GitHub Pro, and this repository is private on the free plan, so a red PR can still be merged by hand. Dependabot opens weekly npm update PRs (`.github/dependabot.yml`), which go through the same job.

## 5. Manual checks before a milestone demo

- Fresh clone → `docker compose up -d && pnpm i && pnpm db:migrate && pnpm ingest && pnpm dev` works from the README alone.
- Production: health green, login for all 4 accounts, one question per role answered, one refusal, viewer highlight, show-sources panel, `/admin/eval` loads.

Roadmap (not MVP): Playwright e2e flows, prompt-injection test corpus, CI evaluation gate.
