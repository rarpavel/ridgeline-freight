# ADR-0022: Use low reasoning effort and flag answers cut off at the output limit

Status: Accepted · Date: 2026-11-03

## Context
ADR-0021 raised `MAX_OUTPUT_TOKENS` to 1,500, but broad questions still spent it. On `gpt-5-mini` reasoning tokens count against the limit, so an answer that ran out before its first citation became a `no_valid_citations` refusal. The text it gave said the documents had no answer, which was not the cause. An answer cut off after a citation passed as complete, ending mid-sentence.

The dev split does not show this: its largest answer used 833 tokens and `falseRefusalRate` is 0.000.

ADR-0021 rejected lowering `reasoning_effort`, because it changes answer quality and needs the judge to measure. A higher limit alone turned out to be close to the 30 s model timeout, so the option is reopened below with the checks available without the judge.

## Decision
- Send `reasoning_effort: low`, set by `REASONING_EFFORT`. `MAX_OUTPUT_TOKENS` stays 1,500.
- Detect `finish_reason: 'length'`. It adds `truncated` to the `done` event and a `chat.output_truncated` log line, and the chat shows a note under the answer or refusal. The text and the refusal rules do not change, so it still fails closed.

Measurements are in `RAG_PIPELINE.md §3.2`. Against the current setup on seven broad questions, refusals at the limit went from 24 of 42 to 0 of 42, cost per question fell by half and TTFT p50 from 9.4 s to 3.8 s.

Rejected:
- **A higher limit at the default effort.** 4,000 also reached no refusals, but cost 2.6 times as much as low, with latency p95 at 28 s against the 30 s timeout and an unchanged TTFT.
- **`minimal`.** It is the fastest, but one of the answers read gave Marlowe & Finch the payment terms of another agreement. It uses no reasoning at all, and nothing here could show that this was a one-off.
- **Refusing every cut-off answer.** It would throw away cited text that is correct as far as it goes.
- **A new refusal reason, or a `truncated` trace column.** Both need a migration for a case that did not occur in 252 runs at low. `output_tokens` at the limit still finds these traces.

## Consequences
- Dev, 5 runs: `falseRefusalRate` 0.000, `refusalAccuracy` 1.000, `leakCount` 0, as before. TTFT p50 is 2.0–2.8 s, within the 3 s target for the first time, and cost per question is $0.0008 against $0.0013.
- **Answer quality is not measured by a judge.** The checks were key facts in the dev answers and one broad question, plus the injection check repeated at low (`SECURITY.md §5`). The test run with the judge (RAG-040) is the real check, and it should be read with this decision in mind.
- Low refuses some open-ended questions more often. "Are late delivery penalties ever waived…" was refused in 22 of 36 runs at low against 7 of 18 at the default. These refusals say the documents do not state a waiver, which is accurate. One comparison answer of 36 was refused for lacking part of the data, which goes against the prompt's rule on partial answers.
- The margin is not large: the largest answer at low used 1,433 of 1,500 tokens, so a limit can still be reached. Then the user sees the note, and the log has the event.
- A model that rejects `reasoning_effort` cannot be set as `CHAT_MODEL` without a code change. That only matters if the model changes.
