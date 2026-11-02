# Deployment

Environments, hosting, database, migrations, smoke checks and rollback. Decision record: ADR-0007.

Last updated: 2026-11-02

## 1. Environments

| | local | production |
|--|-------|------------|
| App | `pnpm dev` (http://localhost:3000) | https://ridgeline-freight.vercel.app, Vercel production from `main` (Git integration), Next.js preset, Node 22.x |
| DB | Docker `pgvector/pgvector:pg17` (`docker-compose.yml`, port 5432 or `POSTGRES_PORT` from `.env`, db `ridgeline`) | Neon Free, project `ridgeline-freight`, branch `main`, db `ridgeline`, Postgres 17, region `aws-us-east-1` (N. Virginia, the same area as Vercel `iad1`) |
| LLM | OpenAI | OpenAI, `DAILY_TOKEN_BUDGET=400000` |
| Auth | demo accounts | demo accounts |

Vercel preview deployments are enabled by default and point at the production database with the same env; they are used only to eyeball a PR and never run migrations.

## 2. Hosting

- **Vercel Hobby**: Fluid compute, Node.js runtime, max duration 300 s (chat responses finish in < 30 s). The project is a non-commercial personal portfolio demo under Vercel's fair-use guidelines; if it becomes paid work, upgrade to Pro.
- **Neon Free**: 1 GB storage, 100 CU-hours/month, scale-to-zero after 5 min (first request after idle pays a cold start; the health check retries). Connection strings: pooled (`-pooler`, `DATABASE_URL`) and direct (`DATABASE_URL_DIRECT`, migrations and CLIs).

## 3. Release flow

```
branch → PR → ci.yml (typecheck, lint, unit, integration) → merge → Vercel builds main → manual smoke
```

- **Migrations** are run from the developer's machine *before* merging a PR that adds one: `DATABASE_URL_DIRECT=<prod> pnpm db:migrate`. Migrations are additive, so the currently deployed app keeps working between the migration and the merge.
- **Ingestion into production**: `DATABASE_URL=<prod direct> pnpm ingest` from the laptop after `data/corpus` changes.
- **Eval against production data**: `DATABASE_URL=<prod direct> pnpm eval --split test`.

## 4. Configuration

Vercel project env: all variables from `CONVENTIONS.md §6` except the eval/data-gen ones. No GitHub secrets are needed for CI (tests use a fake embedder and no model calls).

The required variables (`DATABASE_URL`, `OPENAI_API_KEY`, `SESSION_SECRET`, `DEMO_ACCOUNTS_JSON`) must be set for both Production and Preview before a build, because `next build` loads `src/env.ts` and fails without them. Optional variables stay unset and use their defaults, except `NEXT_PUBLIC_APP_ENV=production`.

`DEMO_ACCOUNTS_JSON` comes from `pnpm hash-password`, which prints one form for each place. Vercel takes the value as is; `.env.local` needs every `$` written as `\$`, because Next.js expands `$` in env files even inside quotes. `src/env.ts` rejects anything that is not a bcrypt hash, so a wrong value fails the build or boot instead of breaking every login.

## 5. Smoke check (manual, after each production deploy)

```
curl -s https://<app>/api/health      # 200 {"status":"ok","db":"ok","embeddingModel":...,"promptVersion":...,"gitSha":...}
```
Then: log in as `sales`, ask one question, open a citation, check the show-sources panel.

## 6. Rollback

- App: Vercel → Deployments → promote the previous production deployment (instant), or `git revert` + push.
- DB: migrations are forward-only; undo with a new migration. Neon's 6-hour history window on Free is the emergency restore.
- Data: `pnpm ingest --force` from the committed corpus.

## 7. Cheatsheet

```
docker compose up -d && pnpm db:migrate && pnpm ingest && pnpm eval:import && pnpm dev   # local from scratch
openssl rand -base64 48                                                                   # new SESSION_SECRET
```
