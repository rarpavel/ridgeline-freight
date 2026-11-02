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
- Events: `chat.done` (gate, tokens, cost, latency, citations valid/dropped, refused), `chat.error`, `auth.login.fail`, `guardrail.rate_limited`, `guardrail.budget_exhausted`, `ingest.document`, `eval.question`.
- Redaction: `authorization`, `cookie`, `*.apiKey`, `*.password`.

## 3. Metrics we look at

| Question | Where |
|----------|-------|
| Is production up, which models/prompts are live? | `GET /api/health` (db ok, embedding model, prompt version, git sha) |
| What did a specific answer retrieve and cite? | UI "Show sources" panel (reads the trace by `traceId`) |
| Latency / cost over time | SQL over `request_traces` / `usage_daily` (no page in the MVP) |
| Refusal rate and dropped citations | same page; `warn` logs |
| Quality over versions | `/admin/eval` run comparison |
| Budget | `usage_daily`, provider dashboard |

## 4. UI "Show sources"

Per answer: list of in-prompt chunks (document, section, page, vector sim, FTS score, RRF, cited ✓), the gate decision, model, prompt version, tokens, cost, TTFT/latency. Non-admin users see the same panel (it is part of the demo); the trace endpoint checks that the trace belongs to the requesting account.

## 5. Alerts (minimal)

- GitHub Actions failure notifications (CI).
- Vercel email on failed deployments.
- No paging; this is a demo. A weekly manual glance at `usage_daily` and the health endpoint is the runbook.
