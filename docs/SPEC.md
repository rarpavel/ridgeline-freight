# SPEC v3 (MVP) — RAG Assistant over Ridgeline Freight Company Documents

Authoritative specification of the project. v1 is the original brief (`docs/00-review/SPEC_ORIGINAL.md`), v2 applied the review (`docs/00-review/SPEC_REVIEW.md`), and v3 cuts the scope to an MVP that a solo developer can ship in 5–6 weeks of evenings. §12 lists what was cut and why; §13 keeps the cut items as a roadmap. The documents under `docs/01-product` … `docs/07-portfolio` must stay consistent with this file.

Last updated: 2026-11-03

## 1. Goal

Ship a public demo of a RAG assistant that answers questions about the internal documents of a fictional US logistics company, **Ridgeline Freight** (Chicago, Illinois), in roughly 70 hours of work (task-level sum in Notion). It is a portfolio piece for US clients on Upwork: an MVP that proves four things convincingly, not a production platform.

The four things the demo must prove:

1. **Verifiable answers** — every claim has a citation; one click opens the clause, highlighted.
2. **Honest refusals** — "this is not in the documents", enforced by code, not only by the prompt.
3. **Role-based access in SQL** — sales never sees HR documents; an automated test proves zero leaks.
4. **Measured quality** — a held-out test set, deterministic metrics plus an independent LLM judge, numbers in the README.

Plus one supporting feature: a "Show sources" panel that exposes retrieval, scores, cost and latency for every answer.

## 2. Functional requirements

| # | Feature | Definition of done | Milestone |
|---|---------|--------------------|-----------|
| 1 | Login | 4 demo accounts (`sales`, `hr`, `ops`, `admin`) shown on the login page; role in an encrypted session cookie | M0 |
| 2 | Ask a question, streamed answer | Single-turn Q&A; first token < 3 s warm (p50); answer streams over SSE | M2 |
| 3 | Citations | Factual sentences end with `[n]`; server validates `[n]` against the context; chips open the viewer at the cited chunk, highlighted | M2–M3 |
| 4 | Refusal | Hard gate (no model call) when nothing relevant is retrieved; model refusal via `NO_ANSWER:`; an answer with zero valid citations becomes a refusal | M2–M3 |
| 5 | Roles | `access_roles && $roles` in every retrieval and viewer query; integration test asserts no leak across roles | M3 |
| 6 | Show sources | Panel per answer: retrieved candidates with vector/FTS/RRF scores, which were cited, gate decision, model, tokens, cost, latency | M3 |
| 7 | Evaluation | `pnpm eval` runs the test split, computes metrics, calls the judge, writes `eval_runs`; `/admin/eval` (admin only, read-only) shows the latest runs and per-question results | M4 |
| 8 | Guardrails | Rate limits per account and IP, question length cap, output cap, daily token budget with a hard stop, basic security headers | M4 |

Conventions: English UI; US formats (`MM/DD/YYYY`, USD). Out of scope for the MVP: conversation history, document upload, multi-tenancy, mobile app, local/alternative model switch, OCR and PDF parsing, reranker, pixel-faithful document rendering, CI evaluation gate, end-to-end browser tests (see §13).

## 3. Architecture

One Next.js 16 application (App Router, TypeScript strict) and one Postgres with pgvector. Ingestion, data generation and evaluation are CLI scripts run from the developer's machine against the same database. The web app only reads chunks and writes traces.

```
data-gen (CLI)   world.json → fact registry → documents (md) → DOCX (docx lib) → validate facts → eval questions
ingest (CLI)     DOCX → mammoth → normalized text → structural chunks → context prefix → embeddings → Postgres
chat (web)       question → role-filtered vector + FTS search → RRF → top-8 (≤3/doc) → gate → LLM (stream)
                 → citation validation → SSE → request_traces
eval (CLI)       test-split questions → same answer code path → deterministic metrics + judge → eval_runs
```

| Layer | Technology | Why |
|-------|------------|-----|
| UI + API | Next.js 16 (App Router), TypeScript strict, Tailwind CSS + shadcn/ui, `proxy.ts` for auth redirects | One repo, the author's stack; shadcn copies components into the repo instead of adding a UI framework |
| Database | Postgres 17 + pgvector (Neon in production; `pgvector/pgvector:pg17` container locally and in CI) | Vectors, FTS and the role filter in one SQL query |
| Data access | Drizzle ORM + drizzle-kit SQL migrations, `pg` | Typed schema, readable migrations |
| LLM | `openai` npm; chat `gpt-5-mini`; embeddings `text-embedding-3-small` (1536) | Cheap; `baseURL` stays configurable so a private endpoint is a config change |
| Judge | `claude-haiku-5-5` via `@anthropic-ai/sdk`, eval CLI only | Different model family than the generator |
| Parsing | `mammoth` (DOCX → HTML with headings and tables) | One parser; we generate the DOCX ourselves |
| Document generation | `docx` npm (Heading styles, tables) | No pandoc, no browser |
| Auth | `iron-session`, bcrypt hashes of 4 demo passwords in env | Simplest secure option |
| Rate limiting / budget | Postgres tables | No extra service |
| Logging | `pino` JSON + `request_traces` | Debuggable answers |
| Hosting | Vercel Hobby + Neon Free | Free, no auto-pause |

## 4. Database

Tables (DDL in `docs/03-data/DATA_MODEL.md`): `documents`, `document_texts`, `chunks` (with `embedding vector(1536)`, `embedding_model`, generated `tsv`), `eval_questions`, `eval_runs`, `eval_results`, `request_traces`, `rate_limits`, `usage_daily`. No vector index: at ~700 chunks an exact scan takes milliseconds and avoids filtered-HNSW recall issues. No `users` table.

## 5. Ingestion

`pnpm ingest [--force] [--only <slug>]`, idempotent by `checksum` + `chunker_version`.

1. Parse DOCX with mammoth: Heading 1/2 → `##`/`###`, paragraphs, lists, tables → Markdown tables. Output: normalized text stored in `document_texts` with section offsets.
2. Chunk by structure: sections and numbered clauses, target 300–600 tokens, small clauses merged, tables kept whole; each chunk records `section_ref`, `section_title`, char offsets.
3. Context prefix `"<title> — <section path>"`; embed and FTS-index `prefix + content`, display `content`.
4. Embeddings in batches of 64 with `text-embedding-3-small`; `embedding_model` stored per chunk.

## 6. Retrieval and generation

1. Vector top-20 (cosine, exact scan) and FTS top-20 (any word of the question, `ts_rank_cd`; ADR-0019), both with `access_roles && $roles`.
2. RRF (k = 60) → top-8, at most 3 chunks per document.
3. Gate: best cosine < `SIM_FLOOR` **and** no chunk holds every word of the question → refusal without a model call. `SIM_FLOOR` calibrated on the dev split.
4. Prompt: versioned system prompt (`prompts/rag-system.v1.md`) + context blocks `[1]..[8]` + the question. `max_tokens ≤ 700`.
5. SSE events: `meta` → `delta`* → `citations` → `done` | `error`.
6. Post-processing: parse `[n]`, drop unknown aliases (logged), detect `NO_ANSWER:`, convert zero-citation answers to refusals, write `request_traces`.

## 7. Synthetic data

24 DOCX documents:

| Type | Count | Roles |
|------|-------|-------|
| Customer Service Agreements (MSA) | 6 | sales, admin |
| Carrier & Subcontractor Agreements | 4 | ops, admin |
| Employee Handbook policies | 6 | hr, admin |
| Warehouse & Delivery SOPs | 4 | ops, admin |
| Rate Sheets (tables inside DOCX) | 4 | sales, admin |

Pipeline (`data-gen/`): world bible → fact registry (5–8 facts per document, `value` + `aliases`, ≥ 8 deliberately differing facts across similar agreements, ≥ 4 exception facts) → documents in Markdown → DOCX via `docx` → validation script (every alias found in the text extracted by the ingestion parser; date/USD regexes; name blocklist) → eval questions by a different model, paraphrased, with distractors, manually reviewed. Dataset version in `data/VERSION`.

## 8. Evaluation

40 questions: direct 16, comparison 6, exception 5, no_answer 8, other_role 5. Split **dev 12 / test 28**; thresholds and prompts tuned on dev; README reports test only.

Metrics: retrieval hit rate (expected docs among the 8 in-prompt chunks), correctness (judge, 0/1 + rationale), faithfulness (judge, share of supported claims), refusal accuracy (no_answer + other_role), leak count (other_role questions with any retrieved chunk from a disallowed document; must be 0), false refusal rate, citation validity, TTFT and latency p50/p95, cost per question. Targets: hit rate ≥ 0.90, correctness ≥ 0.85, faithfulness ≥ 0.90, refusal accuracy ≥ 0.95, leaks = 0. Real numbers are published even when below target.

Runs: `pnpm eval --split test|dev --label <name>` from the developer's machine; results in `eval_runs` / `eval_results`; `/admin/eval` lists runs and per-question rows. A full test run costs ≈ $0.10.

## 9. Security and cost guardrails

- Login required; encrypted httpOnly cookie; `/admin/*` admin-only in `proxy.ts` and in each handler.
- Role filter in SQL for retrieval and the viewer; leak integration test in CI.
- Prompt injection: context treated as data (prompt rules), delimited numbered blocks, restricted Markdown rendering (no HTML, no links), citation validation.
- Limits: 20 requests/hour per account, 40/hour per IP, question ≤ 500 chars, `max_tokens ≤ 700`, daily global token budget with a hard stop and an explicit "budget exhausted" state; provider spend cap in the dashboard.
- Secrets only in server env, validated at boot; basic security headers; no model calls from the browser.

## 10. Observability

Every chat request writes a `request_traces` row (retrieval candidates with scores, gate, prompt version, model, tokens, cost, TTFT, latency, citations valid/dropped, refusal, error) and one structured log line. "Show sources" reads from traces. `/api/health` reports DB connectivity, embedding model, prompt version and git SHA.

## 11. Milestones (5–6 weeks, deploy-first)

| Milestone | Target week | Exit criteria |
|-----------|-------------|---------------|
| M0 Foundations & walking skeleton | 1 | App in production on Vercel with login and `/api/health` hitting Neon; CI (typecheck, lint, unit, integration) green; docs and CLAUDE.md in repo |
| M1 Data ready | 1–2 | world bible, registry, 24 DOCX documents, validator green, 40 reviewed questions with split |
| M2 MVP RAG | 3 | ingest → hybrid search → streamed answer with validated `[n]` citations, deployed |
| M3 Refusal, roles, viewer | 4–5 | gate + `NO_ANSWER:` + zero-citation conversion, RBAC with leak test, viewer with highlight, show-sources panel |
| M4 Evaluation, guardrails, portfolio | 5–6 | `pnpm eval` + judge + `/admin/eval`, guardrails, README with metrics, 2-minute video, Upwork case |

Estimated effort ≈ 70 h (sum of task estimates in the Notion Tasks database; v2 was ≈ 85–115 h).

## 12. What v3 cut from v2 and why

| Cut | Why it is not needed for the MVP | Saved |
|-----|----------------------------------|-------|
| Local model switch (Ollama), per-model embedding table, `dimensions: 1024` | Nobody verifies it in a 2-minute demo; "OpenAI-compatible client, private endpoint possible" stays true for free | ~8 h |
| Scanned PDFs + OCR, PDF table parsing, Playwright, `sharp` | Three parsers for one demo; DOCX with tables covers rate sheets | ~12 h |
| HNSW index, iterative scans, exact-recall metric | ~700 chunks: exact scan is milliseconds and has no post-filter recall problem | ~2 h |
| CI eval regression gate, run-vs-run diff UI, judge agreement study | Manual eval before each milestone is enough | ~9 h |
| Injection test corpus and `injection` category | Prompt and rendering defenses stay; dedicated tests later | ~4 h |
| E2E Playwright tests | Unit + integration (incl. leak test) cover the risk | ~5 h |
| Conversation history | Single-turn Q&A is what the demo shows | ~2 h |
| Preview deployments, Neon branches, migration workflow | `main` → production; migrations run from the laptop | ~4 h |
| `/admin/traces`, detailed log events, IP salting, CSP tuning | `request_traces` + basic headers suffice | ~3 h |
| 34 → 24 documents, 50 → 40 questions | Less review time; corpus still credible | ~2 h |

## 13. Roadmap after MVP (not planned, kept for the README "What's next")

Local model support (Ollama, per-model embeddings), OCR for scanned PDFs and PDF table parsing, HNSW with iterative scans at larger corpus sizes, CI evaluation gate with a baseline, prompt-injection test corpus, conversation history with query condensation, reranker (Cohere), preview environments, pixel-faithful PDF viewer, document upload, multi-tenancy.
