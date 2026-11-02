# Prompt 06 — LLM-as-Judge Rubric

## Purpose
Score one system answer for correctness and faithfulness against the reference answer, the source facts and the text of the cited passages, with a mandatory rationale. Copied verbatim into `prompts/judge.v1.md`.

## Model requirements
A model from a **different family** than the answer generator: `claude-haiku-5-5` via `@anthropic-ai/sdk`, strict JSON output (parsed with zod; one retry with the validation error appended). `max_tokens` 800.

## Inputs
- `{{category}}`, `{{question}}`, `{{role}}`.
- `{{expected_answer}}` — reference answer or `null`.
- `{{facts_json}}` — source facts with `value` and `aliases` (empty for `no_answer`).
- `{{answer}}` — the system's final answer text after citation validation.
- `{{refused}}` — `true|false`.
- `{{cited_passages_json}}` — `[{ "n": 1, "document": "...", "section": "...", "text": "..." }]` for the valid citations.

## Prompt

```
You are grading an answer produced by a document question-answering system for employees of a freight
company. Grade strictly and explain your reasoning. Use only the materials below.

QUESTION ({{category}}, asked by role "{{role}}"): {{question}}
REFERENCE ANSWER (may be null when the correct behavior is to refuse): {{expected_answer}}
SOURCE FACTS (canonical values and accepted aliases): {{facts_json}}
SYSTEM ANSWER (refused={{refused}}): {{answer}}
CITED PASSAGES (the only evidence the system may rely on): {{cited_passages_json}}

Scoring rules:
A. correctness (0 or 1):
   - 1 only if the answer states every value in the reference answer (matching the canonical value or an
     accepted alias), attributes each value to the right document when the question involves more than
     one document, and keeps any qualifier or exception present in the reference.
   - 0 if any value is wrong, missing, attributed to the wrong document, or a qualifier is dropped.
   - If REFERENCE ANSWER is null: correctness is 1 if the system refused, 0 if it stated any value.
   - A refusal when a reference answer exists scores 0.
B. faithfulness (0.0–1.0): split the system answer into atomic factual claims (ignore the refusal line
   and pure phrasing). For each claim decide whether it is supported by the text of a cited passage.
   faithfulness = supported claims / all claims; 1.0 when there are no claims (pure refusal).
C. refusalCorrect: true if the system refused and REFERENCE ANSWER is null; false if it refused but a
   reference exists; null if it did not refuse.
D. Never reward confident tone, length or formatting. Values must match exactly (units, decimals).

Output JSON only:
{
  "correctness": 0 | 1,
  "faithfulness": number,
  "claims": [{ "claim": "string", "supported": true | false, "citation": number | null }],
  "refusalCorrect": true | false | null,
  "rationale": "2–4 sentences explaining the scores, naming any wrong or unsupported value"
}
```

## Output schema
```json
{ "type": "object", "required": ["correctness","faithfulness","claims","refusalCorrect","rationale"],
  "additionalProperties": false,
  "properties": {
    "correctness": {"enum":[0,1]},
    "faithfulness": {"type":"number","minimum":0,"maximum":1},
    "claims": {"type":"array","items":{"type":"object","required":["claim","supported","citation"],
      "properties":{"claim":{"type":"string"},"supported":{"type":"boolean"},"citation":{"type":["integer","null"]}}}},
    "refusalCorrect": {"type":["boolean","null"]},
    "rationale": {"type":"string","minLength":20} } }
```

## Validation rules
- JSON parses and validates; `faithfulness` equals supported/total within 0.01 when `claims` is non-empty (the runner recomputes it and overrides the model's number).
- For `no_answer`/`other_role` questions the runner also checks the deterministic refusal flag; the judge's `refusalCorrect` must agree, otherwise the item is flagged for manual review.
- 20 stratified items are hand-labeled in M4; agreement recorded in `docs/04-ai/EVALUATION.md §4`.

## Example (valid output)
```json
{
  "correctness": 1,
  "faithfulness": 1.0,
  "claims": [
    { "claim": "Harbor Point Foods receives a $250.00 credit per shipment delivered more than 24 hours late", "supported": true, "citation": 1 },
    { "claim": "The credit does not apply to shipments delayed by documented weather events", "supported": true, "citation": 1 }
  ],
  "refusalCorrect": null,
  "rationale": "Both the amount and the weather exception match the reference and appear verbatim in passage [1]. No unsupported claims."
}
```
