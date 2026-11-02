# Ridgeline Freight RAG Assistant

A portfolio MVP: a RAG assistant over 24 synthetic documents of a fictional US logistics company. Specification: [docs/SPEC.md](docs/SPEC.md).

## Run locally

Requires Node 22 or newer, pnpm and Docker with Compose.

```bash
pnpm i
docker compose up -d
cp .env.example .env.local
```

Postgres listens on port 5432. If that port is taken, put `POSTGRES_PORT=<port>` in `.env` before `docker compose up -d` (Compose does not read `.env.local`) and use the same port in the database URLs in `.env.local`.

Fill in the empty required values in `.env.local` (`OPENAI_API_KEY`, `SESSION_SECRET`, `DEMO_ACCOUNTS_JSON`); the app refuses to start without them and names what is missing. Then:

```bash
pnpm dev
```

Open http://localhost:3000.

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`.
