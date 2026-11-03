# Observability

What is logged and traced so that a bad answer can be explained after the fact: per-request traces in Postgres, structured logs, health, and the dashboards we actually use (the admin pages and Vercel logs).

Last updated: 2026-11-03

## 1. Per-request trace (`request_traces`)

Written once per chat request and once per eval question (`source = 'eval'`, from RAG-032). Fields: see `DATA_MODEL.md §2`. The `id` is the `traceId` of the SSE `meta` event. The `retrieval` JSON holds every candidate from both lists and the signals the gate read:

```json
{ "candidates": [{ "chunkId": "…", "documentId": "…", "slug": "msa-harbor-point-foods", "sectionRef": "4.3",
    "vectorRank": 1, "vectorSim": 0.61, "ftsRank": 3, "ftsScore": 0.12, "rrf": 0.0323, "inPrompt": true, "cited": true }],
  "bestSim": 0.61, "simFloor": 0.30, "ftsMatches": 20, "ftsAllTermsMatches": 0, "vectorUnavailable": false }
```

`ftsMatches` is the length of the any-word FTS list, at most 20; `ftsAllTermsMatches` is the count the gate reads (ADR-0019), and it is absent from older traces.

`inPrompt` means the model was given the chunk, so it is false for every candidate of a gate refusal.

This single row, with its `gate` column, answers: what was retrieved, why it was or was not refused, what the model cited, what it cost, how long it took.

The row is written when the request ends, however it ends, and the stream stays open until then, so a client that has read to the end of the stream can read the trace. The `gate` is `refuse_gate` here and in logs; the SSE `meta` event calls the same decision `refuse`.

| Outcome | `error` | `gate` | `model`, `prompt_version` | tokens | `cost_usd` |
|---------|---------|--------|---------------------------|--------|------------|
| Answer or model refusal | null | `answer` | set | set | embedding + model |
| Gate refusal | null | `refuse_gate` | null | null | embedding |
| Model fails or client disconnects mid-answer | `llm_error`, `client_disconnected` | `answer` | set | null | embedding only, because a stream that does not finish reports no usage; the real bill can be higher |
| Retrieval fails | `db_error`, `internal` | `answer` (no gate decision was reached) | null | null | null |

Cost: `src/server/llm/pricing.ts` multiplies token counts by the list prices in `config/pricing.json`, which records the date they were checked as `asOf` and the provider pages they came from. Cached-input discounts are ignored, so a cost can read slightly high. `cost_usd` is null when the embedding call failed or a configured model has no price (`pricing.unknown_model`), so a missing price never reads as a low cost. Prices are re-checked by hand; nothing updates them.

Retention: unbounded in the MVP (demo traffic); prune by hand if the table grows. Question text is stored (synthetic demo, shared accounts); if the project were used with real data, hash or truncate it.

## 2. Logs

- `pino` JSON to stdout; Vercel keeps runtime logs (Hobby: short retention, `TO VERIFY` current window). Fields per line: `level, time, msg, traceId, route, account, role, durationMs` and event-specific data.
- Events: `chat.done` (gate, tokens, cost, latency, citations valid/dropped, refused), `chat.error`, `chat.trace_failed`, `chat.citations_dropped`, `chat.client_disconnected`, `pricing.unknown_model`, `auth.login.fail`, `guardrail.rate_limited`, `guardrail.budget_exhausted`, `ingest.document`, `eval.question`, `health.db_error`, `health.git_sha_unavailable`, `db.pool_error`.
- Redaction: `authorization`, `cookie`, `*.apiKey`, `*.password`.
- Question, passages, prompt and answer never go to the logs; the question and the generated text live only in `request_traces`.
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

Per answer, a "Show sources" button opens a sheet (`src/components/chat/SourcesPanel.tsx`, full width on a phone): the in-prompt chunks (document slug, section, vector sim, FTS score, RRF, cited ✓), the other candidates collapsed under "Not in prompt", the gate decision with best sim, sim floor and FTS matches, model, prompt version, tokens, cost, TTFT/latency. Scores have 3 decimals. A gate refusal reads `gate: refused`, and all its candidates are under "Not in prompt". The button appears once the stream has closed, because the trace is written just before that (§1).

Non-admin users see the same panel (it is part of the demo). `GET /api/traces/:id` answers only the requesting account's traces, admin any; another account's trace, a missing one and a malformed id are the same 404. The response leaves out `question`, `account`, `role` and `generated_text`, so the original text of a converted answer stays in the database. Its shape is `TraceDetails` in `src/lib/trace-details.ts`, and it is never cached (`Cache-Control: no-store`).

## 5. Alerts (minimal)

- GitHub Actions failure notifications (CI).
- Vercel email on failed deployments.
- No paging; this is a demo. A weekly manual glance at `usage_daily` and the health endpoint is the runbook.
