# ADR-0014: MVP scope: 24 DOCX documents, 40 questions, 4–5 weeks

Status: Accepted · Date: 2026-11-02

## Context
Full v2 scope was ~85–115 h; the calendar offers ~12 h/week. The portfolio pitch rests on four things: verifiable citations, enforced refusals, RBAC in SQL with a leak test, measured quality.

## Decision
Keep those four plus the show-sources panel, streaming, hybrid search and guardrails. Cut: local model switch, OCR/PDF, HNSW, CI eval gate, run diff UI, judge agreement study, injection test corpus, e2e tests, conversation history, preview environments, migration workflows, extra admin pages. Corpus 24 DOCX (6 MSA, 4 carrier, 6 HR, 4 SOP, 4 rate sheets), 40 questions. Five milestones over 5–6 weeks, ≈ 70 h (task-level sum). Full list with savings: `docs/SPEC.md §12`.

## Consequences
- The demo proves the pitch with less surface to maintain; the cut items are a visible roadmap in the README.
- Document count and question count are config, not code; the corpus can grow by rerunning data generation.
