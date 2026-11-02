# Engineering Conventions

Repository layout, naming, TypeScript rules, error handling, logging and environment variables. `CLAUDE.md` summarizes this for AI agents; this file is the long form.

Last updated: 2026-11-02

## 1. Repository layout

```
.
├── src/
│   ├── app/                      # Next.js App Router
│   │   ├── login/                # login page
│   │   ├── chat/                 # chat page
│   │   ├── documents/[id]/       # viewer page
│   │   ├── admin/eval/           # eval page (admin)
│   │   └── api/
│   │       ├── chat/route.ts     # POST, SSE
│   │       ├── documents/[id]/route.ts, original/route.ts
│   │       ├── traces/[id]/route.ts
│   │       ├── auth/login/route.ts, logout/route.ts
│   │       └── health/route.ts
│   ├── components/               # React components (ui/, chat/, viewer/, eval/)
│   ├── server/                   # server-only code ("server-only" import at top)
│   │   ├── db/                   # drizzle client, schema/*.ts, queries/*.ts
│   │   ├── ingest/               # parsers/docx.ts, chunker.ts, pipeline.ts
│   │   ├── rag/                  # retrieve.ts, fuse.ts, gate.ts, prompt.ts, generate.ts, citations.ts, trace.ts, answer.ts, refusal.ts
│   │   ├── llm/                  # client.ts (openai), embeddings.ts, pricing.ts, judge.ts (anthropic, CLI only)
│   │   ├── auth/                 # session.ts (iron-session), accounts.ts, require.ts
│   │   ├── guardrails/           # rateLimit.ts, budget.ts, limits.ts
│   │   ├── prompts/              # load.ts, render.ts
│   │   └── eval/                 # runner.ts, metrics.ts, judge-runner.ts
│   ├── lib/                      # pure, isomorphic helpers (markdown, format, sse, errors)
│   ├── env.ts                    # zod-validated env
│   └── proxy.ts                  # auth redirects (Next.js 16 proxy)
├── scripts/                      # CLI entrypoints (tsx): ingest.ts, eval.ts, eval-import.ts, data-gen/*.ts
├── prompts/                      # runtime prompts, versioned files
├── data-gen/                     # prompts/, schemas/, blocklist.txt
├── data/                         # world.json, registry.json, catalog.json, corpus/, generated/, eval/, VERSION
├── config/pricing.json
├── drizzle/                      # SQL migrations
├── tests/                        # unit/, integration/ (see TESTING.md)
├── docs/
├── .github/workflows/ci.yml
├── docker-compose.yml            # local Postgres (pgvector/pgvector:pg17)
├── CLAUDE.md
└── package.json
```

Rule: anything importing `src/server/**` must itself be server-only (route handlers, server components, scripts). `src/lib` has no Node-only imports.

## 2. Naming

- Files: `kebab-case.ts`; React components `PascalCase.tsx`; tests `*.test.ts` under `tests/` mirroring `src/`.
- DB: `snake_case` tables/columns; Drizzle objects `camelCase`; ids are `uuid`.
- Env vars: `UPPER_SNAKE`. Prompt files: `<name>.v<N>.md`. Document slugs: `<type>-<entity>` (`msa-harbor-point-foods`).
- Functions: verbs (`retrieveCandidates`, `fuseRrf`, `validateCitations`); booleans `isX`/`hasX`.

## 3. TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`.
- No `any`; `unknown` + narrowing. No non-null assertions outside tests.
- Runtime validation at boundaries with `zod` (request bodies, LLM JSON outputs, env, JSON files).
- Plain functions and small modules; dependencies (db, llm clients, clock) passed as a `deps` parameter for testability.
- Named exports only.

## 4. Error handling

- `src/lib/errors.ts`: `AppError` with `code` (`rate_limited | budget_exhausted | unauthorized | forbidden | not_found | validation | llm_error | db_error | internal`), `status`, `safeMessage`. Routes map `AppError` → HTTP status + JSON `{ error: { code, message } }`; unknown errors → 500 `internal` with a logged stack.
- SSE routes emit an `error` event and end the stream; never throw after headers were sent.
- CLIs fail fast with a one-line cause and exit code 1; partial work is transaction-scoped.
- Never swallow errors; `catch` logs with the trace id or rethrows.

## 5. Logging

- `pino` JSON to stdout (Vercel collects it); fields: `level, time, msg, traceId, route, account, role, durationMs`. Never log secrets, cookies or full prompts.
- One `info` line per chat request (`chat.done`), `warn` for dropped citations and guardrail hits, `error` with `err`.

## 6. Environment variables (`src/env.ts`, zod)

| Variable | Required | Example / default | Used by |
|----------|----------|-------------------|---------|
| `DATABASE_URL` | yes | Neon pooled URL (`-pooler`) / local | app, CLIs |
| `DATABASE_URL_DIRECT` | migrations | Neon direct URL | drizzle-kit |
| `OPENAI_API_KEY` | yes | `sk-…` | chat, embeddings, data-gen |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | any OpenAI-compatible endpoint |
| `CHAT_MODEL` | no | `gpt-5-mini` | chat |
| `EMBEDDING_MODEL` | no | `text-embedding-3-small` | embeddings |
| `SESSION_SECRET` | yes | ≥ 32 random chars | iron-session |
| `DEMO_ACCOUNTS_JSON` | yes | `[{"id":"sales","role":"sales","passwordHash":"$2b$…"}, …]` | auth |
| `SIM_FLOOR` | no | `0.30` | gate |
| `MAX_QUESTION_CHARS` / `MAX_OUTPUT_TOKENS` | no | `500` / `700` | guardrails |
| `RATE_LIMIT_ACCOUNT_PER_HOUR` / `RATE_LIMIT_IP_PER_HOUR` | no | `20` / `40` | guardrails |
| `DAILY_TOKEN_BUDGET` | no | `400000` | guardrails |
| `ANTHROPIC_API_KEY` / `JUDGE_MODEL` | eval, data-gen | `claude-haiku-5-5` | judge, question generation |
| `DATAGEN_MODEL` / `DATAGEN_QUESTIONS_MODEL` | data-gen | `gpt-5-mini` / `claude-haiku-5-5` | scripts |
| `NEXT_PUBLIC_APP_ENV` | no | `local \| production` | banners |

`.env.example` lists all of them with comments; `src/env.ts` fails at boot with a readable message listing missing variables. Client components read only `NEXT_PUBLIC_*`.

## 7. Code style and tooling

- `pnpm` only (`packageManager` field, `engines.node >= 22`). ESLint (flat config, `typescript-eslint` recommended, `react-hooks`), Prettier defaults (100 cols, single quotes). No git hooks.
- Scripts: `dev`, `build`, `start`, `typecheck`, `lint`, `format`, `test`, `test:integration`, `db:generate`, `db:migrate`, `db:studio`, `ingest`, `eval`, `eval:import`, `datagen:*`.
- Dependencies: one line of justification in the PR for every new package; prefer the versions listed in `docs/00-review/SPEC_REVIEW.md §7` or newer patch releases.
- UI: Tailwind CSS + shadcn/ui initialized at bootstrap (`components.json`, `src/lib/utils.ts` with `cn`, theme tokens as CSS variables) with the primitives `button`, `input`, `textarea`, `badge`, `sheet`, `table`, `skeleton` in `src/components/ui`; add further primitives only in the task that needs them. No other UI frameworks.
