# Evaluation

Dataset design, metrics, judge rubric, targets and how to run. The eval CLI uses the same retrieval and generation code as the chat route, so the numbers describe the product.

Last updated: 2026-11-03

## 1. Dataset

- 44 questions in `data/eval/questions.json`, generated per `SYNTHETIC_DATA.md §6` and manually reviewed (`reviewed: true` required to be imported).
- Categories: direct 16, comparison 6, exception 5, no_answer 8, other_role 5, broad 4.
- Split: `dev` 16 and `test` 28, stratified by category except `broad`, which is dev only. **Only the test split is reported** in the README and the case study; dev is for tuning `simFloor`, chunking and prompts.

| Category | Total | dev | test |
|----------|-------|-----|------|
| direct | 16 | 5 | 11 |
| comparison | 6 | 2 | 4 |
| exception | 5 | 2 | 3 |
| no_answer | 8 | 2 | 6 |
| other_role | 5 | 1 | 4 |
| broad | 4 | 4 | 0 |

- Versioned with `data/VERSION`; every run records it.
- `broad` asks for a value across a document type or a summary of a document, so the answer is long. It guards the output limit while tuning (§7). The first 12 dev questions could not: their largest answer used 833 tokens, so they stayed clean while broad questions were refused at the limit (ADR-0022). It stays out of the test split, so the targets in §3 and the published run are measured on the same 28 questions as before.

## 2. Metrics

Deterministic (no LLM):

| Metric | Definition | Population |
|--------|------------|------------|
| `retrievalHitRate` | all `expectedDocSlugs` have ≥ 1 chunk among the 8 in-prompt chunks | direct, comparison, exception, broad |
| `retrievalHitRate@20` | same, among the 20 fused candidates | same |
| `leakCount` | other_role questions with ≥ 1 retrieved chunk from a disallowed document (must be 0) | other_role |
| `refusalAccuracy` | refused (gate, `NO_ANSWER:`, or zero-citation conversion) | no_answer, other_role |
| `falseRefusalRate` | refused although answerable | direct, comparison, exception, broad |
| `citationValidity` | valid citations / all citations emitted | answered |
| `ttftP50/P95`, `latencyP50/P95` | ms to first delta / to done | all |
| `costPerQuestion` | USD from `pricing.json` | all |
| `truncatedAnswers` | answers the model stopped at `MAX_OUTPUT_TOKENS` (`finish_reason: length`), refused or not | all |
| `outputTokensMax` | largest `outputTokens`, reasoning included; `null` if no question reached the model | all |

LLM judge (per answered question): `correctness` 0/1 (expected values present, attributed to the right document, qualifiers kept) and `faithfulness` 0–1 (share of claims supported by cited chunk text). Refusals are judged too, for the agreement check in §4, but stay out of these two aggregates: `refusalAccuracy` and `falseRefusalRate` already measure them, and the 1.0 the rubric gives a refusal would inflate `faithfulness`. `needsReview` and `judgeErrors` count flagged and unscored results across all of them. All four are `null` in a run without the judge.

Aggregates in `eval_runs.metrics`: per category and overall.

## 3. Targets (test split)

| Metric | Target | Published run | Met |
|--------|--------|---------------|-----|
| retrievalHitRate | ≥ 0.90 | 1.000 | yes |
| correctness | ≥ 0.85 | 0.824 | **no** |
| faithfulness | ≥ 0.90 | 1.000 | yes |
| refusalAccuracy | ≥ 0.95 | 1.000 | yes |
| leakCount | 0 | 0 | yes |
| falseRefusalRate | ≤ 0.10 | 0.056 | yes |
| ttftP50 (warm) | < 3,000 ms | 3,268 ms | **no** |

Honest reporting: a missed target is published with the real value and a one-line reason.

Published run: `98810a54-3c7c-47ae-b43b-3777247ec443`, label `published`, 2026-11-03, production database, `test` split (28 questions), commit `976dd0c`, `gpt-5-mini`, `text-embedding-3-small`, prompt `rag-system@v3#5dc28de8`, dataset `2026.11-2`, judge `claude-haiku-5-5`, `simFloor` 0.45, `finalK` 8, `perDocCap` 3. Also: `citationValidity` 1.000, `costPerQuestion` $0.00069, `latencyP50` 3,357 ms, `truncatedAnswers` 0, `outputTokensMax` 835, `needsReview` 0, `judgeErrors` 0.

Nothing was tuned after this run (ADR-0013). What the numbers mean:

- **correctness** is 14 of 17 answered questions. `comparison-05` is a real miss: the sections stating the 90 and 180 days were among the candidates but not among the 8 passages in the prompt. `exception-01` and `exception-04` answered the yes/no question correctly, with a valid citation, and left out a value the reference states (§4). A score of 1 on those two would give 0.941; the published value stays 0.824.
- **ttftP50** rises with the model's hidden reasoning: over the 22 questions that reached the model, the correlation between `ttft_ms` and `output_tokens` is 0.76. The CLI ran on a developer laptop, not on Vercel, and traces hold no timing breakdown, so the network's share is not separated.
- **retrievalHitRate** counts documents, not passages, so 1.000 hides a limit. In `comparison-05` and in `direct-02`, the one false refusal, the expected document reached the prompt but the section with the answer did not. This is the limit §7 shows for `broad` (`finalK` 8, `perDocCap` 3).

## 4. Judge (`prompts/judge.v1.md`, authored in `data-gen/prompts/06-judge.md`)

- Model: `claude-haiku-5-5` (ADR-0009). Inputs: question, expected answer, source facts (value + aliases), the system's answer after citation validation, the text of the cited chunks, the category.
- Output (strict JSON): `{ correctness, faithfulness, claims[], refusalCorrect, rationale }`; the runner recomputes `faithfulness` from `claims`.
- Rules: values must match the expected value or an alias; a correct value attributed to the wrong document is `correctness: 0`; exception questions need the qualifier; a refusal on an answerable question is 0.
- Runner (`src/server/eval/judge-runner.ts`): `max_tokens` 4000, no sampling parameters. The model's hidden thinking counts against the limit: replies with about 400 tokens of visible JSON used 1,500–1,900 in all, so the 800 first planned cut off about one reply per dev run. An invalid reply, or one cut off at `max_tokens`, gets one retry with the error appended. After that, or on any other provider error (the SDK has already retried it), the result stores `scores.judgeError` and the run goes on; `--resume` does not judge it again.
- Agreement check: rule C of the rubric follows from what the system did (a refusal is correct exactly when there is no reference answer, and an answer is `null`). A judge who disagrees, or who finds no claims in an answer, sets `scores.needsReview`. The judge's own value is `scores.judgeRefusalCorrect`; `scores.refusalCorrect` stays the deterministic flag.
- Sanity check in M4: read 10 judged items by hand; note disagreements in this file.
- Hand check, 2026-11-03: all 12 items of the dev run `5f3217e7` (`rag-036-judge-3`), 9 answered and 3 refused, read against the question, reference and cited text. No value was misjudged and no unsupported claim was missed; `needsReview` was 0 and `judgeErrors` 0. Two scores show the rubric's "every value" rule applied unevenly: `exception-03` got 0 for leaving out the $150.00 limit and receipts on a yes/no question it answered correctly, while `direct-06` got 1 although it left out the reference's "410 miles". Read literally the rule gives 0 to both, and read by what was asked it gives 1 to both. So `correctness` can move by one item on how a reference is worded. An earlier run also counted a derived difference ($490,000.00) as supported, though no passage states it, so `faithfulness` is slightly lenient on arithmetic. Neither changes the rubric for now; both are worth reading again on the published run.
- Hand check of the published run, 2026-11-03: the 18 judged answers to `direct`, `comparison` and `exception` questions, read against the question and reference. No value was misjudged. The uneven rule shows again: `exception-01` and `exception-04` got 0 for leaving out a reference value on a yes/no question they answered correctly. Arithmetic is still lenient: `comparison-01` states "15 fewer days" as supported. The rubric stays as it is (ADR-0013).

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

Headline metrics are hit rate, correctness, faithfulness, refusal accuracy, leaks, p50 TTFT and cost per question, shown overall in the list and per category in the detail. The detail always lists every category, filters its question rows with `?category=<name>` (an unknown name shows every row) and opens the judge's rationale in a `<details>` element. A metric a run does not have shows `—`, and an unfinished run is marked `Not finished`. The trace link opens the JSON of `GET /api/traces/:id`; there is no trace page.

Server components read through `src/server/db/queries/eval.ts`, with no API of their own. Access is checked in `proxy.ts` and again by `requireRole('admin')` in both pages (`tests/integration/admin-eval.test.ts`). The page does not link from the chat: an admin opens the URL directly.

## 7. Answers at the output limit

`falseRefusalRate` alone misses part of this fault: an answer cut off after its first citation is not refused. `truncatedAnswers` counts both kinds, and `outputTokensMax` shows the margin left before any answer reaches the limit. Neither stops a run or has a target; read them after any change to the prompt, the model, `REASONING_EFFORT` or `MAX_OUTPUT_TOKENS`. The effort and the limit are not recorded in `eval_runs`, so put them in the label. Both metrics are in the CLI table and in `eval_runs.metrics`, not on `/admin/eval`.

Check on 2026-11-03, `pnpm eval --split dev --no-judge`, dataset `2026.11-2`, prompt `rag-system.v3`, limit 1,500, 3 runs per setting. `medium` is the control for the fault of ADR-0022: `REASONING_EFFORT` cannot leave the parameter out, as the code did before that change.

| Effort (labels) | falseRefusalRate, all / broad | truncatedAnswers | outputTokensMax | refusalAccuracy | leakCount | Cost per question |
|-----------------|-----|---|-----|---|---|-----|
| **low** (`broad-low-1500-1..3`) | **0.000 / 0.000 in all 3** | **0, 0, 0** | **1,230, 1,134, 1,116** | **1.000** | **0** | **$0.00101–0.00106** |
| medium (`broad-control-medium-1500-1..3`) | 0.154, 0.154, 0.231 / 0.500, 0.500, 0.750 | 3, 3, 3 | 1,500, 1,500, 1,500 | 1.000 | 0 | $0.00180–0.00182 |

Every answer at the limit came from a broad question, so the first 12 dev questions alone still show nothing at `medium`. `broad-02` and `broad-03` were refused at the limit in all 3 control runs and `broad-01` in 1. `broad-04` was cut off in 2 and kept its citations, so only `truncatedAnswers` shows those. At `low`, `broad-03` uses up to 82% of the limit, the smallest margin in the set.

Dev numbers from before dataset `2026.11-2` cover 12 questions, so compare them by category, not overall: `broad` raises the overall latency and cost.

**What these questions do not show yet: complete answers.** No answer at `low` is cut off, but only `broad-01` has all its facts, in all 3 runs. The rest are limited by the 8 passages in the prompt, not by tokens (a literal search for the fact values, per run):

| Question | Facts found at low | Why |
|----------|-----|-----|
| `broad-01` | 6 of 6 | All six MSAs reach the prompt |
| `broad-02` | 5 of 12 | Harbor Point and Cedar Valley never reach the prompt, so its `retrievalHit` is false; of the other 4, only Lakeshore and Northline give both values |
| `broad-03` | 7 of 12 | All four agreements reach the prompt, but none of the payment terms do, nor Granite Fork's detention rate |
| `broad-04` | 2 of 6, really 1 | Other handbooks take 5 of the 8 passages, so the hours, detention, layover and OS&D sections miss the prompt. The second match is a false one: layover and lumper fees are both $150.00 |

In run 1, the answers to `broad-02` and `broad-03` say what the passages leave out rather than guessing it. The judge should score these three questions low on `correctness` until retrieval changes, and no judge has run on them. That is a retrieval limit (`finalK` 8, `perDocCap` 3), outside this check.

Roadmap (not MVP): CI regression gate against a committed baseline, run-vs-run diff view, formal judge/human agreement study.
