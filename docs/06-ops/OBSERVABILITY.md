# Observability

What is logged and traced so that a bad answer can be explained after the fact: per-request traces in Postgres, structured logs, health, and the dashboards we actually use (the admin pages and Vercel logs).

Last updated: 2026-11-02

## 1. Per-request trace (`request_traces`)

Written once per chat request and once per eval question (`source = 'eval'`). Fields: see `DATA_MODEL.md §2`. The `retrieval` JSON holds every candidate from both lists:

```json
[{ "chunkId": "…", "documentId": "…", "slug": "msa-harbor-point-foods", "sectionRef": "4.3",
   "vectorRank": 1, "vectorSim": 0.61, "ftsRank": 3, "ftsScore": 0.12, "rrf": 0.0323, "inPrompt": true, "cited": true }]
```

plus `gate`, `bestSim`, `simFloor`, `ftsMatches`, `vectorUnavailable`. This single row answers: what was retrieved, why it was or was not refused, what the model cited, what it cost, how long it took.

Retention: unbounded in the MVP (demo traffic); prune by hand if the table grows. Question text is stored (synthetic demo, shared accounts); if the project were used with real data, hash or truncate it.

## 2. Logs

- `pino` JSON to stdout; Vercel keeps runtime logs (Hobby: short retention, `TO VERIFY` current window). Fields per line: `level, time, msg, traceId, route, account, role, durationMs` and event-specific data.
- Events: `chat.done` (gate, tokens, cost, latency, citations valid/dropped, refused), `chat.error`, `auth.login.fail`, `guardrail.rate_limited`, `guardrail.budget_exhausted`, `ingest.document`, `eval.question`, `health.db_error`, `health.git_sha_unavailable`, `db.pool_error`.
- Redaction: `authorization`, `cookie`, `*.apiKey`, `*.password`.
- Errors logged as `err` keep only `type`, `message`, `stack`, `code`, and the same fields of nested `cause` and `errors`, because `pg` attaches its client, password included, to its errors.

## 3. Metrics we look at

| Question | Where |
|----------|-------|
| Is production up, which models/prompts are live? | `GET /api/health` (db ok, embedding model, prompt version, git sha) |
| What did a specific answer retrieve and cite? | UI "Show sources" panel (reads the trace by `traceId`) |
| Latency / cost over time | SQL over `request_traces` / `usage_daily` (no page in the MVP) |
| Refusal rate and dropped citations | same page; `warn` logs |
| Quality over versions | `/admin/eval` run comparison |
| Budget | `usage_daily`, provider dashboard |

### `GET /api/health`

Public (no session) and never cached (`Cache-Control: no-store`). `SELECT 1` has an 8 s timeout, so a hung database answers 503 within 9 s.

```json
200 { "status": "ok", "db": "ok", "embeddingModel": "text-embedding-3-small", "promptVersion": "rag-system@v1#<8 hex>", "gitSha": "<40 hex>" }
503 { "status": "error", "db": "error", "embeddingModel": "text-embedding-3-small", "promptVersion": "rag-system@v1#<8 hex>", "gitSha": "<40 hex>" }
```

- `gitSha`: `VERCEL_GIT_COMMIT_SHA`, else `git rev-parse HEAD`, else `unknown`.
- `promptVersion`: the runtime system prompt, from `RAG_SYSTEM_PROMPT_VERSION` in `src/server/rag/prompt.ts`.
- The cause of a failure never appears in the response; it is logged as `health.db_error`.
- Cold start, measured on production on 2026-11-02 (one sample, `aws-us-east-1` with Vercel `iad1`, from a client in Europe): 1.9 s after 10.5 minutes idle, without a retry; 0.9 s for the first request after the deploy.

## 4. UI "Show sources"

Per answer: list of in-prompt chunks (document, section, page, vector sim, FTS score, RRF, cited ✓), the gate decision, model, prompt version, tokens, cost, TTFT/latency. Non-admin users see the same panel (it is part of the demo); the trace endpoint checks that the trace belongs to the requesting account.

## 5. Alerts (minimal)

- GitHub Actions failure notifications (CI).
- Vercel email on failed deployments.
- No paging; this is a demo. A weekly manual glance at `usage_daily` and the health endpoint is the runbook.
