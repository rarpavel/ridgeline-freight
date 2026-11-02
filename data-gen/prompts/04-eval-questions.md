# Prompt 04 — Evaluation Questions

## Purpose
Generate the evaluation set: questions by category with expected answers, expected documents and roles, written as a real employee would ask — paraphrased, sometimes indirect, with distractors — so that the eval does not reward lexical matching.

## Model requirements
A **different model family** from the one that wrote the documents (default `claude-haiku-5-5`); JSON output. The model receives facts and the world bible, never the document text. One call per category.

## Inputs
- `{{category}}` — `direct | comparison | exception | no_answer | other_role`.
- `{{count}}` — number of questions for this category (16 / 6 / 5 / 8 / 5).
- `{{registry_json}}` — all facts (for `no_answer`, the model must avoid them).
- `{{world_json}}`, `{{catalog_json}}` (slug, title, type, roles).
- `{{dataset_version}}`.

## Prompt

```
You are writing evaluation questions for a document assistant used by employees of Ridgeline Freight, LLC.
Employees have roles: sales (MSAs, rate sheets), hr (employee handbook policies), ops (carrier agreements,
SOPs), admin (everything). A question is asked by a person with one role.

CATEGORY: {{category}} — produce exactly {{count}} questions.
WORLD: {{world_json}}
CATALOG: {{catalog_json}}
FACTS: {{registry_json}}

Question object:
{
  "slug": "{{category}}-<two-digit sequence>",
  "category": "{{category}}",
  "role": "sales|hr|ops|admin",
  "question": "natural question as an employee would type it",
  "expectedAnswer": "short reference answer with the exact value(s) and qualifiers, or null",
  "expectedDocSlugs": ["slugs of documents that contain the answer"],
  "sourceFactIds": ["factIds used"],
  "distractorDocSlugs": ["similar documents that do NOT contain the answer"],
  "notes": "why this question is hard, one sentence"
}

Category rules:
- direct: one fact, one document. The role must be allowed to read the document.
- comparison: two documents of the same type, same category of fact (use "differsFrom"); the question
  names both subjects; expectedAnswer gives both values attributed to each document.
- exception: a fact with "isException": true; the question probes the qualifier ("does X apply when…");
  expectedAnswer must contain the qualifier.
- no_answer: plausible for the role, about Ridgeline Freight, but NOT answerable from any fact or world
  entity (e.g., executive compensation, a customer not in the world, a policy that does not exist).
  expectedAnswer = null, expectedDocSlugs = [].
- other_role: answerable from a document the role is NOT allowed to read (e.g., sales asking about PTO
  accrual). expectedAnswer = null (the assistant must refuse); expectedDocSlugs lists the document that
  would answer it; "notes" names the disallowed document type.

Style rules (all categories):
1. Paraphrase. Never reuse more than 4 consecutive words from a fact's "statement". Vary verbs and
   nouns ("how long do we have to pay", "what do we charge when a driver waits", "is there a cap").
2. At least 40% of questions are indirect or role-played ("A Harbor Point dispatcher is asking…").
3. Use entity names from WORLD; never invent names. Abbreviations are fine ("HPF" is not — use real
   names from WORLD).
4. Mix lengths: 6–25 words.
5. Dates MM/DD/YYYY, money as $1,250.00 in expectedAnswer.
6. JSON array only.
```

## Output schema
```json
{ "type": "array", "items": { "type": "object",
  "required": ["slug","category","role","question","expectedAnswer","expectedDocSlugs","sourceFactIds","distractorDocSlugs","notes"],
  "properties": {
    "slug": {"type":"string","pattern":"^(direct|comparison|exception|no_answer|other_role)-\\d{2}$"},
    "category": {"enum":["direct","comparison","exception","no_answer","other_role"]},
    "role": {"enum":["sales","hr","ops","admin"]},
    "question": {"type":"string","minLength":20,"maxLength":200},
    "expectedAnswer": {"type":["string","null"]},
    "expectedDocSlugs": {"type":"array","items":{"type":"string"}},
    "sourceFactIds": {"type":"array","items":{"type":"string"}},
    "distractorDocSlugs": {"type":"array","items":{"type":"string"}},
    "notes": {"type":"string"} } } }
```

The script adds `split` (stratified dev/test), `reviewed: false`, `datasetVersion`.

## Validation rules (`pnpm datagen:questions` post-check)
- Schema valid; counts per category exact; slugs unique.
- Every `expectedDocSlugs`/`distractorDocSlugs` exists in the catalog; every `sourceFactIds` exists in the registry and belongs to an expected document.
- Role/document consistency: for `direct|comparison|exception` the role is in `access_roles` of every expected document; for `other_role` it is in none.
- Overlap check: no 5-gram shared between `question` and the source fact `statement`.
- `no_answer`: no fact value or alias appears in the question's expected answer (null) and the question does not name a non-existent document as if it existed.
- Manual review sets `reviewed: true` (`EVALUATION.md §1`).

## Example (valid output, one item)
```json
[{
  "slug": "comparison-03",
  "category": "comparison",
  "role": "sales",
  "question": "If a load for Harbor Point Foods and one for Lakeshore Retail both show up a day late, which customer gets the bigger credit?",
  "expectedAnswer": "Harbor Point Foods receives $250.00 per late shipment; Lakeshore Retail Group receives $175.00 per late shipment, so Harbor Point Foods gets the bigger credit.",
  "expectedDocSlugs": ["msa-harbor-point-foods", "msa-lakeshore-retail"],
  "sourceFactIds": ["msa-harbor-point-foods#03", "msa-lakeshore-retail#03"],
  "distractorDocSlugs": ["msa-prairie-wind-mfg"],
  "notes": "Requires chunks from two MSAs and per-document attribution; a third MSA has a similar clause."
}]
```
