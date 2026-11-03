# ADR-0021: Raise the output limit to 1,500 tokens and put the refusal marker first

Status: Accepted, its rejection of a lower `reasoning_effort` superseded by ADR-0022 · Date: 2026-11-03

## Context
Calibrating `SIM_FLOOR` (`RAG_PIPELINE.md §3.1`) showed two faults the floor cannot fix.

The 700-token limit from the spec was set for visible text, but on `gpt-5-mini` reasoning tokens count against it. Answers were cut off before their first citation and became `no_valid_citations`: that was every false refusal in the runs at 700, and also 10 of 18 refusals on `no_answer` questions.

Rule 8 of `rag-system.v1` asked the model to describe what the documents cover and then add a `NO_ANSWER:` line. `citations.ts` recognizes a refusal only at the start of the answer (CLAUDE.md rule 3), so these counted as answers and the user saw the marker in the text.

## Decision
- `MAX_OUTPUT_TOKENS` defaults to 1,500. The largest answer in the runs used 1,229.
- `rag-system.v2` makes `NO_ANSWER:` come first and alone, treats a near match as no answer, and keeps partial answers to multi-part questions, cited and without the marker.

Rejected: finding the marker anywhere in `citations.ts`. Deltas are already streamed by then, and it would keep a form that shows text before refusing. Rejected: lowering `reasoning_effort`. It may also help TTFT, but it changes answer quality and needs the judge (RAG-036) to measure.

## Consequences
- Dev at `SIM_FLOOR=0.45`: `falseRefusalRate` 0.000, `refusalAccuracy` 1.000, `leakCount` 0 in 5 of 5 runs, with no marker outside the start of an answer. The dev split has 12 questions and these runs had no judge, so the test run (RAG-040) is the real check.
- A maximum-length answer costs about twice as much in output tokens. `DAILY_TOKEN_BUDGET` still caps total spend.
- If the model ever writes the marker after other text, it still counts as an answer and the user sees it. The validator is unchanged.
- TTFT is not improved: p50 is 4.2–5.3 s on dev against the 3 s target.
