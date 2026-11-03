# Eval question review (RAG-018)

Review of the 40 questions in `questions.json` against the checklist in `docs/03-data/SYNTHETIC_DATA.md §6`. Reviewed by an AI agent on 2026-11-02 by comparing each question with its source facts and the Markdown source of its documents. Refusal questions were checked by searching all documents the role can read for the topic.

Checklist: unambiguous; one correct answer from the facts; the expected documents contain it; role is right; no leakage of the exact fact wording; US dates and amounts; category correct.

26 questions passed unchanged. 14 were edited, one of them replaced. Slugs did not change, so the split did not change. No registry fact or document changed.

| Question | Field | Why |
|---|---|---|
| direct-01 | answer, notes | No document says "from the invoice date", only Net 30; there are six MSAs, not five |
| direct-03 | question | "Our carriers" was wrong: in an MSA the Carrier is Ridgeline |
| direct-06 | question, answer, notes | The lane has two rates, dry van $2.10 and reefer $2.40, so the question had two answers |
| direct-07 | notes | The table has 14 tiers, not four |
| direct-11 | question, answer | No document says when the Net 10 period starts |
| direct-13 | question | Grammar |
| comparison-01 | answer | Same as direct-01 |
| comparison-02 | question | A Northline buyer would not be told another customer's contract terms |
| comparison-05 | question | Joliet is a warehouse, not an office |
| exception-01 | answer | "Not billed by Ridgeline" is in the fact statement but not in the document |
| exception-04 | notes | The $125,000.00 cap on the FTL rate sheet is general, not specific to Marlowe & Finch |
| no_answer-05 | question | Rewording: a deductible is not something a carrier "carries" |
| no_answer-06 | notes | The carrier agreements do mention driver qualification, in general terms |
| no_answer-07 | replaced | The $55.00 per diem covers meals for all employees on business travel, so the original meal stipend question was answerable. The new question asks about a referral bonus |

## Left as is

- **Invoice date aliases.** The registry aliases for payment terms still say "from the invoice date". They do not affect `pnpm datagen:validate`, which matches on the value `Net N`, so they stay.
- **Indirect questions.** At least 20 of 40 use indirect phrasing (the rule is ≥ 40%).
- **Rate sheet terms next to MSA terms.** The FTL rate sheet's TONU and cargo cap terms differ from the MSAs. The questions that touch them name the customer, and the rate sheet is listed as a distractor.

## Broad questions (2026-11-03)

Four questions added to the dev split to catch answers at the output limit (`docs/04-ai/EVALUATION.md §7`). Written by hand and reviewed by an AI agent against the same checklist: each source fact's value was found in the Markdown source of its document and in the expected answer, and `pnpm datagen:questions` passes. The other 40 questions are unchanged.

| Question | Role | Source facts | Note |
|---|---|---|---|
| broad-01 | sales | 6, from all 6 MSAs | Ad hoc question from `RAG_PIPELINE.md §3.2`, unchanged |
| broad-02 | sales | 12, from all 6 MSAs | Ad hoc question, unchanged |
| broad-03 | ops | 12, from all 4 carrier agreements | "Insurance" replaced with detention, because the registry has no insurance facts to check an answer against |
| broad-04 | hr | 6, from the driver handbook | "Everything the handbook says" narrowed to the driver handbook, which gives one correct answer |

Three ad hoc questions were left out: "Are late delivery penalties ever waived…" has no fact behind it and is often refused for that reason, and "What obligations do we have…" and "Summarize every fee…" have no single correct answer.
