# Ridgeline Freight RAG Assistant

[![CI](https://github.com/rarpavel/ridgeline-freight/actions/workflows/ci.yml/badge.svg)](https://github.com/rarpavel/ridgeline-freight/actions/workflows/ci.yml)

A portfolio MVP: a RAG assistant over 24 synthetic documents of a fictional US logistics company. Specification: [docs/SPEC.md](docs/SPEC.md).

## Demo

Live at https://ridgeline-freight.vercel.app. It has sign-in, a health check at [/api/health](https://ridgeline-freight.vercel.app/api/health) and a chat that streams answers with citations. Citation links lead to a 404 until the document viewer is added.

Sign in at [/login](https://ridgeline-freight.vercel.app/login) with one of four demo accounts: `sales`, `hr`, `ops` or `admin`. Their passwords are listed on that page, because these are public demo credentials and all the data is synthetic.

## Run locally

Requires Node 22 or newer, pnpm and Docker with Compose.

```bash
pnpm i
docker compose up -d
cp .env.example .env.local
```

Postgres listens on port 5432. If that port is taken, put `POSTGRES_PORT=<port>` in `.env` before `docker compose up -d` (Compose does not read `.env.local`) and use the same port in the database URLs in `.env.local`.

Fill in the empty required values in `.env.local` (`OPENAI_API_KEY`, `SESSION_SECRET`, `DEMO_ACCOUNTS_JSON`); the app refuses to start without them and names what is missing. `pnpm hash-password` prints a ready `DEMO_ACCOUNTS_JSON` line for `.env.local`, with random passwords and every `$` escaped as `\$`. Then:

```bash
pnpm db:migrate
pnpm ingest
pnpm dev
```

`pnpm ingest` indexes the 24 documents in `data/corpus` (embeddings cost well under $0.01). A repeat run skips unchanged documents; `--force` rewrites them and `--only <slug>` limits the run to one document.

Open http://localhost:3000/login. The session cookie is always `Secure`; Chrome and Firefox accept that on `localhost`, but Safari may not, so use one of those to sign in locally.

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## Milestones

- **M0, 2026-11-02:** the app runs in production on Vercel and Neon with sign-in for four demo accounts, a health check and CI.
- **M1, 2026-11-02:** the data is ready: 24 synthetic DOCX documents pass validation, and 40 reviewed eval questions are split into dev 12 and test 28 (`data/VERSION` 2026.11-1).
- **M2, 2026-11-03:** production answers questions from the indexed corpus (24 documents, 423 chunks) with streamed text and citation chips, checked with one question for each of the four roles.
