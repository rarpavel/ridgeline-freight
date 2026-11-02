# Synthetic Data

How the Ridgeline Freight corpus and the evaluation set are produced: the world bible, the fact registry (JSON Schema), the document catalog, the generation pipeline, DOCX rendering, the validation script, and the eval-question pipeline. Prompts are in `data-gen/prompts/`.

Last updated: 2026-11-02

## 1. Principles

- **Facts first.** Every number, date, amount, term and name that matters comes from `data/registry.json`; documents are written from facts, never the other way round.
- **One world.** `data/world.json` fixes the company, customers, carriers, lanes, addresses and calendar so all documents agree with each other.
- **No real entities.** No real companies, people, addresses, phone numbers, DOT/MC numbers. A blocklist check runs on every generated text; all catalog names were checked against web search on 2026-11-02 (see §4). The generator must not invent company names outside `world.json`.
- **US realism.** USD with two decimals, `MM/DD/YYYY`, Illinois governing law, Net-N payment terms, accessorial/detention/layover fees, PTO accrual, at-will employment, FMCSA-style compliance language without real regulation numbers.
- **Versioned.** `data/VERSION` (e.g. `2026.11-1`) changes whenever the registry, documents or questions change; eval runs record it.

## 2. World bible — `data/world.json`

```json
{
  "company": { "name": "Ridgeline Freight, LLC", "hq": { "street": "4100 S Pulaski Rd", "city": "Chicago", "state": "IL", "zip": "60632" },
               "founded": "2009", "fiscalYearStart": "01/01", "officers": [{ "title": "Chief Executive Officer", "name": "Fictional Name" }] },
  "customers": [ { "id": "cust-harbor-point", "name": "Harbor Point Foods, Inc.", "industry": "food distribution", "city": "Milwaukee", "state": "WI" } ],
  "carriers":  [ { "id": "car-brightwater", "name": "Brightwater Carriers LLC", "equipment": ["dry van", "reefer"], "state": "IN" } ],
  "lanes":     [ { "id": "lane-chi-mke", "origin": "Chicago, IL", "destination": "Milwaukee, WI", "miles": 92 } ],
  "glossary":  { "detention": "...", "accessorial": "...", "layover": "..." }
}
```

Generated once by `pnpm datagen:world` (part A of `data-gen/prompts/01-fact-registry.md`), then **hand-edited and frozen**.

## 3. Fact registry — `data/registry.json`

JSON Schema (`data-gen/schemas/registry.schema.json`):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["version", "facts"],
  "properties": {
    "version": { "type": "string" },
    "facts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["factId", "docSlug", "category", "statement", "value", "aliases", "valueType"],
        "additionalProperties": false,
        "properties": {
          "factId":      { "type": "string", "pattern": "^[a-z0-9-]+#[0-9]{2}$" },
          "docSlug":     { "type": "string" },
          "category":    { "enum": ["payment_terms","penalty","liability_cap","term_and_termination","notice_period","rate","fee","threshold","policy_rule","date","party","exception","other"] },
          "statement":   { "type": "string", "minLength": 20 },
          "value":       { "type": "string" },
          "aliases":     { "type": "array", "items": { "type": "string" }, "minItems": 1 },
          "valueType":   { "enum": ["money","days","percent","date","number","text"] },
          "sectionHint": { "type": "string" },
          "isException": { "type": "boolean", "default": false },
          "differsFrom": { "type": "array", "items": { "type": "string" } },
          "entityIds":   { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
}
```

Rules enforced by `pnpm datagen:validate-registry`:
- 5–8 facts per document; every `docSlug` exists in the catalog.
- `value` is the canonical rendering (`$1,250.00`, `Net 30`, `04/15/2026`, `2%`); `aliases` lists accepted alternatives (`$1,250`, `thirty (30) days`, `April 15, 2026`).
- ≥ 8 facts carry `differsFrom` linking the same `category` in another document of the same type with **different** values (penalties, payment terms, liability caps across MSAs; detention rates across carriers; accrual rates across policies).
- ≥ 4 facts have `isException: true`.
- No two documents share the same `value` for `penalty` or `liability_cap`.
- Every `entityIds` entry exists in `world.json`.

## 4. Document catalog — `data/catalog.json` (24 documents, all DOCX)

| Slug | Title | Type | Roles |
|------|-------|------|-------|
| msa-harbor-point-foods | Master Service Agreement — Harbor Point Foods, Inc. | msa | sales, admin |
| msa-lakeshore-retail | Master Service Agreement — Lakeshore Retail Group | msa | sales, admin |
| msa-prairie-wind-mfg | Master Service Agreement — Prairie Wind Manufacturing | msa | sales, admin |
| msa-marlowe-finch-medical | Master Service Agreement — Marlowe & Finch Medical Supply | msa | sales, admin |
| msa-northline-auto | Master Service Agreement — Northline Auto Parts | msa | sales, admin |
| msa-cedar-valley-beverages | Master Service Agreement — Cedar Valley Beverages | msa | sales, admin |
| carrier-brightwater | Carrier Agreement — Brightwater Carriers LLC | carrier_agreement | ops, admin |
| carrier-ashgrove-haulage | Carrier Agreement — Ashgrove Haulage LLC | carrier_agreement | ops, admin |
| carrier-juniper-bend | Carrier Agreement — Juniper Bend Logistics | carrier_agreement | ops, admin |
| carrier-granite-fork-intermodal | Subcontractor Agreement — Granite Fork Intermodal | carrier_agreement | ops, admin |
| hr-pto-holidays | Employee Handbook — Paid Time Off and Holidays | hr_policy | hr, admin |
| hr-remote-hybrid-work | Employee Handbook — Remote and Hybrid Work | hr_policy | hr, admin |
| hr-travel-expense | Employee Handbook — Business Travel and Expense Reimbursement | hr_policy | hr, admin |
| hr-conduct-at-will | Employee Handbook — Code of Conduct and At-Will Employment | hr_policy | hr, admin |
| hr-driver-hours-safety | Employee Handbook — Driver Hours and Safety Compliance | hr_policy | hr, admin |
| hr-attendance-leave | Employee Handbook — Attendance and Leaves of Absence | hr_policy | hr, admin |
| sop-inbound-receiving | SOP — Inbound Receiving and Dock Scheduling | sop | ops, admin |
| sop-outbound-pick-pack | SOP — Outbound Pick, Pack and Ship | sop | ops, admin |
| sop-hazmat-handling | SOP — Hazardous Materials Handling | sop | ops, admin |
| sop-osd-exceptions | SOP — Delivery Exceptions and OS&D Claims | sop | ops, admin |
| rate-ltl-midwest | Rate Sheet — Regional LTL, Midwest Lanes (2026) | rate_sheet | sales, admin |
| rate-ftl-dry-van | Rate Sheet — Full Truckload Dry Van (2026) | rate_sheet | sales, admin |
| rate-accessorials | Accessorial Fee Schedule (2026) | rate_sheet | sales, admin |
| rate-fuel-surcharge | Fuel Surcharge Table (2026) | rate_sheet | sales, admin |

Name check (web search, 2026-11-02): no exact matches for any customer or carrier name above. Eight earlier candidates were replaced because they matched or closely resembled real businesses (Great Lakes Medical Supply, Ironwood Manufacturing, Redline Trucking, TriState Haulers, Fox River Terminals, Heartland Intermodal Gateway, Keystone Lines, Northwest Express). Acceptable near-misses: Harbor Foods (PNW distributor) vs. our Harbor Point Foods. Re-run the check when the world bible adds names.

## 5. Generation pipeline

```
pnpm datagen:world              → data/world.json              (prompt 01 part A; then hand-edit)
pnpm datagen:registry           → data/registry.json           (prompt 01 part B)  + validate-registry
pnpm datagen:docs               → data/generated/md/<slug>.md  (prompt 02; rate sheets: prompt 03 → JSON tables → Markdown tables)
pnpm datagen:render             → data/corpus/<type>/<slug>.docx
pnpm datagen:validate           → report: every alias found? format checks, blocklist
pnpm datagen:questions          → data/eval/questions.json     (prompt 04; different model than docs)
```

Document, registry and rate-sheet generation use the `openai` client (`src/server/llm/client.ts`) with `DATAGEN_MODEL` (default `gpt-5-mini`); question generation uses a different model family through `src/server/llm/judge.ts` (`@anthropic-ai/sdk`, `DATAGEN_QUESTIONS_MODEL`, default `claude-haiku-5-5`). Sampling parameters are left at provider defaults. Outputs are committed; regeneration is deliberate (`--force`).

### 5.1 Markdown → DOCX (`docx` library, `scripts/data-gen/render.ts`)

- `#` → Title, `##` → Heading 1, `###` → Heading 2 (real `HeadingLevel` styles so mammoth emits `<h1>/<h2>`), paragraphs, numbered lists, Markdown tables → Word tables with a header row.
- Header: company name; footer: document id. Letter size.
- Rate sheets: prompt 03 returns JSON tables; the script converts them to Markdown tables inside a short document (title, intro, one `##` section per table, notes) and renders the same way.

### 5.2 Validation script (`pnpm datagen:validate`)

For every document in the catalog:
1. Extract text with the **same parser ingestion uses** (`src/server/ingest/parsers/docx.ts`), so validation proves what retrieval will see — including table cells.
2. Normalize: collapse whitespace, unify quotes/dashes, lowercase.
3. For each fact of the document: pass if any `alias` (normalized) is an exact substring.
4. Format checks on the whole text: every date matches `\b\d{2}/\d{2}/\d{4}\b`; every amount matches `\$\d{1,3}(,\d{3})*(\.\d{2})?`; no ISO dates; no `€`/`£`; no `http`, `@`, or phone-like patterns.
5. Blocklist: `data-gen/blocklist.txt` (real carriers, 3PLs, retailers, manufacturers the model tends to produce).
6. Output: `data/generated/validation-report.json` with per-document pass/fail and missing facts; non-zero exit on any failure (CI runs it on `data/**` changes).

## 6. Eval questions — `data/eval/questions.json`

Schema per question: `slug`, `category`, `split`, `role`, `question`, `expectedAnswer` (null for refusals), `expectedDocSlugs[]`, `sourceFactIds[]`, `distractorDocSlugs[]`, `reviewed`, `notes`.

Generation rules (prompt 04):
- The writer model is **different** from the document writer; it receives facts and world entities, **not** document text.
- Paraphrase: the question must not contain more than 4 consecutive words from `statement`; ≥ 40% of questions use indirect phrasing (role-play: "a customer asks how long they have to pay…").
- Comparison questions name two documents and expect both values; distractor questions name a similar document with a different value.
- `no_answer` questions are plausible for the role but absent from all documents (e.g., CEO salary, a customer not in the world).
- `other_role` questions are answerable from documents the role cannot access; the expected behavior is refusal with zero retrieved chunks.
- Split assignment is stratified by category (dev ≈ 30%).

Manual review checklist (each question, `reviewed: true` only when all hold): unambiguous; one correct answer from the facts; the expected document(s) really contain it; role is right; no leakage of the exact fact wording; dates/amounts in US format; category correct.

Counts: direct 16, comparison 6, exception 5, no_answer 8, other_role 5 = 40. Split: dev 12 / test 28.

## 7. Review effort

Target: 8 minutes per document (checklist skim, not a full read), 2 minutes per question. ≈ 4.5 h total across M1, spread over two evenings.
