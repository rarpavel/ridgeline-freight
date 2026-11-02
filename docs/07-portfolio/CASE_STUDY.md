# Case Study, Demo Video and README Structure

Draft of the Upwork case study, the 2-minute demo video script, and the README outline. Numbers in brackets are placeholders filled from the published `test` eval run.

Last updated: 2026-11-02

## 1. Upwork case study (draft)

**Title:** Production-grade RAG assistant for a logistics company's contracts, SOPs and HR policies — with verifiable citations, role-based access and measured accuracy

**The problem.** A mid-size freight company keeps the answers to everyday questions — late-delivery penalties, detention fees, PTO accrual, hazmat procedures — inside dozens of contracts, rate sheets and policies. People search shared drives, ask colleagues, and sometimes quote the wrong customer's terms. Off-the-shelf "chat with PDF" tools hallucinate, cite nothing you can check, and show everyone everything.

**What I built.** A document assistant for a fictional Chicago freight company (Ridgeline Freight, 24 synthetic documents) that:
- answers in plain English with numbered citations; one click opens the exact clause;
- says "this isn't in the documents" when it isn't — enforced three ways (retrieval gate, model refusal, citation validation), not just asked for in a prompt;
- enforces roles (sales, HR, ops, admin) in the database query, with automated tests proving zero cross-role leaks;
- shows its work: every answer has a "sources" panel with retrieved passages, scores, cost and latency;
- is measured: a held-out test set of [28] questions across five categories, scored deterministically and by an independent LLM judge, with the methodology public.

**Results (test split, [date], model [gpt-5-mini], prompt [v1]).** Retrieval hit rate [xx%] · correctness [xx%] · faithfulness [xx%] · refusal accuracy [xx%] · cross-role leaks 0 · median time to first token [x.x s] · cost per answer [$0.00x].

**Stack.** Next.js 16 (App Router, TypeScript strict), PostgreSQL + pgvector (hybrid vector + full-text search, Reciprocal Rank Fusion), OpenAI-compatible model client, Drizzle ORM, Vercel + Neon, GitHub Actions CI.

**What adapts to your company.** Your documents (DOCX today; PDF and scans on the roadmap), your roles and permissions, your model provider (any OpenAI-compatible endpoint, including private deployments), your cloud (AWS/Azure/GCP or on-prem). Synthetic demo data contains no PII; nothing is used to train models.

**Links.** Live demo (demo logins on the page) · 2-minute video · GitHub repository · evaluation methodology.

## 2. Demo video script (2:00, English voice-over, 1080p, cursor visible)

| Time | Scene | Narration (short) |
|------|-------|-------------------|
| 0:00–0:10 | Login page, pick `sales` | "Ridgeline Freight is a fictional logistics company with 24 internal documents. I'm logging in as a sales rep." |
| 0:10–0:40 | Ask: "What is the late delivery penalty in the Harbor Point Foods MSA?" → streamed answer with `[1]` → click chip → viewer scrolls to §4.3 highlighted; open "Show sources" | "Every claim carries a citation. One click opens the clause. The sources panel shows what was retrieved, with scores, cost and latency." |
| 0:40–1:00 | Ask: "Which has the stricter liability cap, Harbor Point Foods or Lakeshore Retail?" → two figures, two citations | "Comparison questions pull passages from two documents and attribute each figure to its source." |
| 1:00–1:15 | Ask: "What is the CEO's salary?" → refusal | "When the documents don't contain the answer, it says so. Refusals are enforced by the retrieval gate and by citation validation, not just by the prompt." |
| 1:15–1:35 | Ask: "How many PTO days do drivers accrue per month?" as `sales` → refusal; sources panel shows zero retrieved chunks | "Access control lives in the SQL query. A sales user never retrieves HR documents — zero chunks, and an automated test proves it." |
| 1:35–2:00 | `/admin/eval`: metrics table and per-question results; back to the chat with the show-sources panel open | "Quality is measured on a held-out test set — hit rate, correctness, faithfulness, refusal accuracy — with an independent judge model. Code and methodology are public." |

Recording checklist: warm the DB and model first (one throwaway question); 1440×900 window; hide bookmarks; prepare the four questions in a text file; record in one take per scene; add captions.

## 3. README structure

1. Title + one-paragraph pitch + badges (CI, eval gate) + links (demo, video, case study).
2. **Demo**: URL, the four demo logins, three suggested questions per role, note on synthetic data.
3. **What it does** (bullets mirroring §1) + screenshot (chat with chips + sources panel).
4. **Architecture**: Mermaid diagram (ingest / query / eval), stack table, link to `docs/02-architecture/ARCHITECTURE.md`.
5. **Evaluation**: metrics table (metric, value, split, model, prompt version, dataset version, date), how to run, link to `docs/04-ai/EVALUATION.md`.
6. **Run locally**: `docker compose up -d`, `pnpm i`, `.env.example`, `pnpm db:migrate`, `pnpm ingest`, `pnpm dev`.
7. **Security & cost guardrails**: short list, link to `docs/06-ops/SECURITY.md`.
8. **Limitations**: synthetic corpus of 24 DOCX documents, English only, single-turn questions, no document upload, demo-scale rate limits, evaluation by one judge model with a small manual check.
9. **Roadmap**: local model support, OCR/PDF, CI evaluation gate, injection test corpus, conversation history, reranker (from `docs/SPEC.md §13`).
10. **Project docs** index (`docs/`), decisions (`docs/02-architecture/adr/`).
11. **Milestone log** (dated entries M0…M4) and license (MIT).
