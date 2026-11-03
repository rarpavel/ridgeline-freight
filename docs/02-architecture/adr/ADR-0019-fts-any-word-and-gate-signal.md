# ADR-0019: FTS candidates match any word; the gate reads an all-terms count

Status: Accepted · Date: 2026-11-03

## Context
`websearch_to_tsquery` ANDs every word of the question. On the local corpus (423 chunks), under each question's role filter, it matched no chunk for 40 of the 40 eval questions, so the FTS half of hybrid retrieval contributed nothing to fusion. Eval questions paraphrase the documents by design (ADR-0013), so a chunk rarely holds every word.

ORing the lexemes fixes the list: `ts_rank_cd` alone then puts an expected document in the top 8 for all 27 answerable questions. But the same query matches at least one chunk for all 40 questions, the 8 `no_answer` and 5 `other_role` ones included. A gate reading that list would never refuse any of them. "zebra quantum violin recipe" would still be refused, but only because none of its words occur in the corpus, so it does not show that the gate still works.

These figures need no model call. The share of questions the gate refuses depends on cosine, which was not measured here.

## Decision
- FTS candidates: `plainto_tsquery` with `&` replaced by `|`, ranked by `ts_rank_cd`, role filter unchanged. `websearch_to_tsquery` operators no longer apply to this list; questions are natural language.
- The gate reads `ftsAllTermsMatches`: a separate count under `websearch_to_tsquery` and the same role filter. It refuses when cosine is below `SIM_FLOOR` and that count is 0. This replaces "FTS returned nothing" in ADR-0004, and it refuses exactly the questions it refused before this change.
- `ftsMatches` stays the length of the candidate list, and both counts go into the trace.

Rejected: a threshold on the share of question words matched by the best chunk. On the dev split the ranges overlap (answerable 0.40–0.82, should-refuse 0.17–0.46), and it would add a second threshold to tune on 12 questions. Also rejected: dropping FTS from the gate, which loses ADR-0004's case of an exact term match at low cosine.

## Consequences
- FTS now shapes the prompt for ordinary questions. The effect on fused retrieval and on answers is not measured yet; the next eval run on the dev split shows it, and RAG-033 should compare against this change, not earlier numbers.
- All 40 eval questions have an all-terms count of 0, so for them the gate is decided by cosine alone, as it already was. `SIM_FLOOR` carries the gate, and its calibration in RAG-033 is not affected by this change.
- When the embedding call fails, a natural-language question is still refused at the gate, even though the candidate list is no longer empty. The behaviour is unchanged, but the FTS-only fallback only helps keyword queries.
- One more statement per request in the retrieval transaction.
