# ADR-0008: Rate limiting and budget stop in Postgres

Status: Accepted · Date: 2026-11-02

## Context
A public demo with an LLM key needs per-account/IP limits and a global daily budget. Adding Redis (Upstash) is possible but is another service.

## Decision
`rate_limits(key, window_start, count)` with one upsert per request (fixed 1-hour windows), `usage_daily(day, requests, input_tokens, output_tokens, cost_usd)` updated after each request; the chat route refuses with 429/503 before any model call. Limits from env: 20/h per account, 40/h per IP, daily token budget.

## Consequences
- One extra DB round trip per request (fine at demo scale).
- Fixed windows allow a 2× burst at window edges; acceptable for a demo. Upstash remains the documented alternative.
