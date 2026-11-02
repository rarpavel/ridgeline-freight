# PRD — Ridgeline Freight Document Assistant

Product requirements for the demo: the problem, who uses it, what is in and out of scope, and how success is measured. Technical design lives in `docs/02-architecture/ARCHITECTURE.md`; this file answers "what and for whom".

Last updated: 2026-11-02

## Problem

Mid-size US logistics companies keep operational knowledge in dozens of contracts, rate sheets, SOPs and HR policies. Staff answer recurring questions ("what is the detention fee for Customer X?", "how many PTO days accrue per month?") by searching shared drives or asking a colleague. Answers are slow, inconsistent, and sometimes wrong because people read the wrong version or the wrong customer's agreement. Generic "chat with your PDF" tools do not solve this: they hallucinate, cite nothing verifiable, and show every employee every document.

## Audience

**Primary audience of the demo:** US clients on Upwork (founders, ops managers, CTOs of small/mid companies) evaluating whether the author can deliver a production-grade RAG system. They spend 1–2 minutes: watch the video, scan the metrics table, click the live demo, maybe open the repo.

**Personas inside the fictional company** (used for roles, demo accounts and eval questions):

| Persona | Role | Typical questions | Allowed documents |
|---------|------|-------------------|-------------------|
| Dana, Account Executive | `sales` | penalties, payment terms, liability caps, rates and accessorial fees for a named customer | MSAs, rate sheets |
| Marcus, HR Generalist | `hr` | PTO accrual, remote work eligibility, travel reimbursement, at-will language | Employee Handbook policies |
| Priya, Operations Manager | `ops` | carrier liability, detention/layover rules, warehouse SOP steps, delivery exceptions | carrier agreements, SOPs |
| Admin | `admin` | everything; runs and reads evaluations | all |

## Scope (MVP)

In scope:

1. Login with one of 4 demo accounts (role in session).
2. Chat: ask a question, get a streamed answer with numbered citations (single-turn; no history).
3. Citations open a document viewer at the cited chunk, highlighted; the viewer shows the document's normalized text with section and page markers and a link to the original file.
4. Refusal when the documents do not contain the answer or the user's role does not allow the documents that do.
5. "Show sources" panel: retrieved candidates with scores, which were cited, model, latency, cost.
6. Admin: `/admin/eval` with evaluation runs and per-question results; `/api/health`.
7. Guardrails: rate limits, input caps, daily budget stop.

Out of scope (explicitly): conversation history, document upload by users, multi-tenancy, mobile app, local/alternative model switch, OCR and PDF parsing, pixel-faithful document rendering, SSO/OAuth, reranker, languages other than English. See `docs/SPEC.md §13` for the roadmap.

## User stories and acceptance

- As `sales`, I ask "What is the late delivery penalty in the Harbor Point Foods MSA?" and get the exact figure with `[1]` pointing to the penalty clause; clicking `[1]` opens the MSA at that clause.
- As `sales`, I ask "Which has the stricter liability cap, Harbor Point Foods or Lakeshore Retail?" and get both figures, each attributed to its MSA, with two citations.
- As `ops`, I ask "Does the detention charge apply to hazmat loads?" and the answer preserves the exception.
- As `sales`, I ask about PTO accrual and get a refusal with no HR content and zero retrieved chunks shown in the trace.
- As anyone, I ask "What is the CEO's salary?" and get "This is not in the documents I can access."
- As `admin`, I open `/admin/eval` and see the latest run with hit rate, correctness, faithfulness, refusal accuracy, leaks, latency, cost, and can compare two runs.
- As a visitor without login, I am redirected to the login page; the login page shows the demo credentials and a note that data is synthetic.

## Success metrics

| Metric | Target | Where measured |
|--------|--------|----------------|
| Retrieval hit rate (test split) | ≥ 90% | `pnpm eval`, README |
| Correctness (judge, test split) | ≥ 85% | `pnpm eval`, README |
| Refusal accuracy (no_answer + other_role) | ≥ 95% | `pnpm eval` |
| Cross-role leaks | 0 | integration test + eval |
| Time to first token, warm, p50 | < 3 s | `request_traces` |
| Monthly demo cost | < $10 | provider dashboards, `usage_daily` |
| Demo availability | no dead link for a client (no DB auto-pause) | hosting choice |

Non-goals for metrics: beating benchmarks, supporting large corpora, sub-second latency.

## Constraints

- Solo developer, ~12 h/week, 5–6 weeks (≈ 70 h).
- Free hosting tiers; public repository; synthetic data only, no PII, no real company names.
- Everything user-visible in English, US formats.
