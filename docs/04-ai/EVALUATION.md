# Evaluation

Dataset design, metrics, judge rubric, targets and how to run. The eval CLI uses the same retrieval and generation code as the chat route, so the numbers describe the product.

Last updated: 2026-11-03

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

LLM judge (per answered question): `correctness` 0/1 (expected values present, attributed to the right document, qualifiers kept) and `faithfulness` 0–1 (share of claims supported by cited chunk text). Refusals are judged too, for the agreement check in §4, but stay out of these two aggregates: `refusalAccuracy` and `falseRefusalRate` already measure them, and the 1.0 the rubric gives a refusal would inflate `faithfulness`. `needsReview` and `judgeErrors` count flagged and unscored results across all of them. All four are `null` in a run without the judge.

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
- Runner (`src/server/eval/judge-runner.ts`): `max_tokens` 4000, no sampling parameters. The model's hidden thinking counts against the limit: replies with about 400 tokens of visible JSON used 1,500–1,900 in all, so the 800 first planned cut off about one reply per dev run. An invalid reply, or one cut off at `max_tokens`, gets one retry with the error appended. After that, or on any other provider error (the SDK has already retried it), the result stores `scores.judgeError` and the run goes on; `--resume` does not judge it again.
- Agreement check: rule C of the rubric follows from what the system did (a refusal is correct exactly when there is no reference answer, and an answer is `null`). A judge who disagrees, or who finds no claims in an answer, sets `scores.needsReview`. The judge's own value is `scores.judgeRefusalCorrect`; `scores.refusalCorrect` stays the deterministic flag.
- Sanity check in M4: read 10 judged items by hand; note disagreements in this file.
- Hand check, 2026-11-03: all 12 items of the dev run `5f3217e7` (`rag-036-judge-3`), 9 answered and 3 refused, read against the question, reference and cited text. No value was misjudged and no unsupported claim was missed; `needsReview` was 0 and `judgeErrors` 0. Two scores show the rubric's "every value" rule applied unevenly: `exception-03` got 0 for leaving out the $150.00 limit and receipts on a yes/no question it answered correctly, while `direct-06` got 1 although it left out the reference's "410 miles". Read literally the rule gives 0 to both, and read by what was asked it gives 1 to both. So `correctness` can move by one item on how a reference is worded. An earlier run also counted a derived difference ($490,000.00) as supported, though no passage states it, so `faithfulness` is slightly lenient on arithmetic. Neither changes the rubric for now; both are worth reading again on the published run.

## 5. Running

```
pnpm eval --split test --label "m4-baseline"
pnpm eval --split dev  --sim-floor 0.28          # tuning
pnpm eval --split test --no-judge                # deterministic metrics only, no Anthropic key needed
pnpm eval --resume <runId> --no-judge
```

Behavior: imports questions if this dataset version has none, stops before creating a run if an `expectedDocSlugs` document is not ingested, runs questions with 2-way concurrency, writes `eval_results` as it goes, computes aggregates at the end, prints a table and the run id. Requires `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY` unless `--no-judge`; a missing key stops the CLI before the run, and so does a `sourceFactIds` entry missing from `data/registry.json`.

Each question is answered by `answerQuestion` with `source: 'eval'`, under the account `eval` and the question's role, so traces are real and `eval_results.trace_id` links to them. `retrieved` holds every fused candidate, best first; `retrievalHitRate@20` reads the first 20. A metric whose population is empty is `null`, not 0, `leakCount` included. `citationValidity` follows the population above: an answer converted to a refusal for having no valid citation leaves it, and each alias counts once per answer. `retrievalHitRate` reads what reached the prompt, so a gate refusal counts as a miss and `retrievalHitRate@20` shows whether retrieval found the document. Percentiles use the nearest rank; `costPerQuestion` averages the questions with a known cost. `eval_runs.metrics` is `{ overall, byCategory }`, each holding the metrics above plus `questions`.

A question that fails (model or database error) does not stop the others. The run then stays open: `finished_at` and `metrics` stay null, the CLI exits 1 and prints the `--resume` command. Ctrl-C does the same and cancels the questions in flight. `--resume` skips questions with a result and reuses the split, label and `simFloor` of the run; it refuses a finished run, and one whose git commit, model, embedding model, judge model (so a run can't end half judged), prompt version or dataset version has changed. It cannot see a re-ingest on the same commit, so don't re-ingest between the two. Questions edited under the same `data/VERSION` are not re-imported: bump the version, or run `pnpm eval:import`.

Cost per full test run: 28 × (≈ 4k input + 0.5k output tokens on `gpt-5-mini`) + judge ≈ **$0.10**. `costPerQuestion` is what the product spends on an answer, so it leaves the judge out.

When to run: before closing M2 (`--no-judge`, dev), M3 (dev, tuning), M4 (test, the published run labeled `published`), and after any change to prompts, chunker or retrieval.

## 6. `/admin/eval`

Read-only: list of runs (label, date, model, prompt version, dataset version, headline metrics); run detail with per-question rows (category, question, expected, answer, refused, hit, correctness, faithfulness, latency, trace link). The README table is copied by hand from the `published` run, with the date.

Headline metrics are hit rate, correctness, faithfulness, refusal accuracy, leaks, p50 TTFT and cost per question, shown overall in the list and per category in the detail. The detail always lists all five categories, filters its question rows with `?category=<name>` (an unknown name shows every row) and opens the judge's rationale in a `<details>` element. A metric a run does not have shows `—`, and an unfinished run is marked `Not finished`. The trace link opens the JSON of `GET /api/traces/:id`; there is no trace page.

Server components read through `src/server/db/queries/eval.ts`, with no API of their own. Access is checked in `proxy.ts` and again by `requireRole('admin')` in both pages (`tests/integration/admin-eval.test.ts`). The page does not link from the chat: an admin opens the URL directly.

Roadmap (not MVP): CI regression gate against a committed baseline, run-vs-run diff view, formal judge/human agreement study.
