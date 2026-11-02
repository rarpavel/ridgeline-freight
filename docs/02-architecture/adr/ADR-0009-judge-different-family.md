# ADR-0009: LLM-as-judge from a different model family

Status: Accepted · Date: 2026-11-02

## Context
Judging with the generator's own model inflates correctness. Faithfulness needs a per-claim check against cited chunks.

## Decision
Judge = `claude-haiku-5-5` via `@anthropic-ai/sdk` in the eval CLI only (the web app never needs the Anthropic key). Fixed rubric (`prompts/judge.v1.md`), strict JSON output with a mandatory rationale, deterministic settings. 10 judged items are read by hand in M4 and disagreements noted in `EVALUATION.md`.

## Consequences
- Two provider keys for the eval CLI; price `TO VERIFY` at launch (cached: $0.10 / $0.50 per 1M).
- `--no-judge` runs deterministic metrics without the Anthropic key.
