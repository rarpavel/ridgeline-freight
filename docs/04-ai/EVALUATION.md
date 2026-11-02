# Evaluation

Dataset design, metrics, judge rubric, targets and how to run. The eval CLI uses the same retrieval and generation code as the chat route, so the numbers describe the product.

Last updated: 2026-11-02

## 1. Dataset

- 40 questions in `data/eval/questions.json`, generated per `SYNTHETIC_DATA.md §6` and manually reviewed (`reviewed: true` required to be imported).
- Categories: direct 16, comparison 6, exception 5, no_answer 8, other_role 5.
- Split: `dev` 12 and `test` 28, stratified by category. **Only the test split is reported** in the README and the case study; dev is for tuning `simFloor`, chunking and prompts.

| Category | Total | dev | test |
|----------|-------|-----|------|
| direct | 16 | 5 | 11 |
| comparison | 6 | 2 | 4 |
| exception | 5 | 2 | 3 |
| no_answer | 8 | 2 | 6 |
| other_role | 5 | 1 | 4 |

- Versioned with `data/VERSION`; every run records it.

## 2. Metrics

Deterministic (no LLM):

| Metric | Definition | Population |
|--------|------------|------------|
| `retrievalHitRate` | all `expectedDocSlugs` have ≥ 1 chunk among the 8 in-prompt chunks | direct, comparison, exception |
| `retrievalHitRate@20` | same, among the 20 fused candidates | same |
| `leakCount` | other_role questions with ≥ 1 retrieved chunk from a disallowed document (must be 0) | other_role |
| `refusalAccuracy` | refused (gate, `NO_ANSWER:`, or zero-citation conversion) | no_answer, other_role |
| `falseRefusalRate` | refused although answerable | direct, comparison, exception |
| `citationValidity` | valid citations / all citations emitted | answered |
| `ttftP50/P95`, `latencyP50/P95` | ms to first delta / to done | all |
| `costPerQuestion` | USD from `pricing.json` | all |

LLM judge (per answered question): `correctness` 0/1 (expected values present, attributed to the right document, qualifiers kept) and `faithfulness` 0–1 (share of claims supported by cited chunk text).

Aggregates in `eval_runs.metrics`: per category and overall.

## 3. Targets (test split)

| Metric | Target |
|--------|--------|
| retrievalHitRate | ≥ 0.90 |
| correctness | ≥ 0.85 |
| faithfulness | ≥ 0.90 |
| refusalAccuracy | ≥ 0.95 |
| leakCount | 0 |
| falseRefusalRate | ≤ 0.10 |
| ttftP50 (warm) | < 3,000 ms |

Honest reporting: a missed target is published with the real value and a one-line reason.

## 4. Judge (`prompts/judge.v1.md`, authored in `data-gen/prompts/06-judge.md`)

- Model: `claude-haiku-5-5` (ADR-0009). Inputs: question, expected answer, source facts (value + aliases), the system's answer after citation validation, the text of the cited chunks, the category.
- Output (strict JSON): `{ correctness, faithfulness, claims[], refusalCorrect, rationale }`; the runner recomputes `faithfulness` from `claims`.
- Rules: values must match the expected value or an alias; a correct value attributed to the wrong document is `correctness: 0`; exception questions need the qualifier; a refusal on an answerable question is 0.
- Sanity check in M4: read 10 judged items by hand; note disagreements in this file.

## 5. Running

```
pnpm eval --split test --label "m4-baseline"
pnpm eval --split dev  --sim-floor 0.28          # tuning
pnpm eval --split test --no-judge                # deterministic metrics only, no Anthropic key needed
pnpm eval --resume <runId>
```

Behavior: imports questions if missing, resolves `expectedDocSlugs` → ids, runs questions with 2-way concurrency, writes `eval_results` as it goes, computes aggregates at the end, prints a table and the run id. Requires `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY` unless `--no-judge`.

Cost per full test run: 28 × (≈ 4k input + 0.5k output tokens on `gpt-5-mini`) + judge ≈ **$0.10**.

When to run: before closing M2 (`--no-judge`, dev), M3 (dev, tuning), M4 (test, the published run labeled `published`), and after any change to prompts, chunker or retrieval.

## 6. `/admin/eval`

Read-only: list of runs (label, date, model, prompt version, dataset version, headline metrics); run detail with per-question rows (category, question, expected, answer, refused, hit, correctness, faithfulness, latency, trace link). The README table is copied by hand from the `published` run, with the date.

Roadmap (not MVP): CI regression gate against a committed baseline, run-vs-run diff view, formal judge/human agreement study.
