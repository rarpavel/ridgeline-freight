# Synthetic Data

How the Ridgeline Freight corpus and the evaluation set are produced: the world bible, the fact registry (JSON Schema), the document catalog, the generation pipeline, DOCX rendering, the validation script, and the eval-question pipeline. Prompts are in `data-gen/prompts/`.

Last updated: 2026-11-03

## 1. Principles

- **Facts first.** Every number, date, amount, term and name that matters comes from `data/registry.json`; documents are written from facts, never the other way round.
- **One world.** `data/world.json` fixes the company, customers, carriers, lanes, addresses and calendar so all documents agree with each other.
- **No real entities.** No real companies, people, addresses, phone numbers, DOT/MC numbers. A blocklist check runs on every generated text; all catalog names were checked against web search on 2026-11-02 (see §4). The generator must not invent company names outside `world.json`.
- **US realism.** USD with two decimals, `MM/DD/YYYY`, Illinois governing law, Net-N payment terms, accessorial/detention/layover fees, PTO accrual, at-will employment, FMCSA-style compliance language without real regulation numbers.
- **Versioned.** `data/VERSION` (e.g. `2026.11-1`) changes whenever the registry, documents or questions change; eval runs record it.

## 2. World bible — `data/world.json`

```json
{
  "company": { "name": "Ridgeline Freight, LLC", "hq": { "street": "1432 Quarrystone Avenue", "city": "Chicago", "state": "IL", "zip": "60632" },
               "founded": "2009", "fiscalYearStart": "01/01", "officers": [{ "title": "Chief Executive Officer", "name": "Marian Voss" }] },
  "customers": [ { "id": "cust-harbor-point-foods", "name": "Harbor Point Foods, Inc.", "industry": "Food & Beverage", "city": "Rockford", "state": "IL", "commodity": "packed and frozen groceries", "volumeBand": "5k-20k" } ],
  "carriers":  [ { "id": "car-brightwater", "name": "Brightwater Carriers LLC", "equipment": ["dry van", "reefer", "flatbed"], "state": "WI", "fleetSizeBand": "150-300" } ],
  "lanes":     [ { "id": "lane-chi-mke", "origin": "Chicago, IL", "destination": "Milwaukee, WI", "miles": 92 } ],
  "warehouses": [ { "id": "wh-chicago-west", "name": "Ridgeline Freight Warehouse - Chicago West", "street": "2107 Northwind Terrace", "city": "Chicago", "state": "IL", "zip": "60639", "docks": 24 } ],
  "glossary":  { "detention": "...", "layover": "...", "accessorial": "...", "tonu": "...", "lumperFee": "...", "osd": "...", "hazmat": "...", "reefer": "..." }
}
```

Counts are fixed by `data-gen/schemas/world.ts`: 4 officers, 6 customers, 4 carriers, 10 lanes, 3 warehouses. Customer and carrier names come from the catalog titles, and ids come from the document slugs (`msa-northline-auto` → `cust-northline-auto`, `carrier-brightwater` → `car-brightwater`).

Generated once by `pnpm datagen:world` (part A of `data-gen/prompts/01-fact-registry.md`), then **hand-edited and frozen**: if the file exists, the script writes nothing unless given `--force`. A run writes the file only after the schema, catalog, blocklist and URL/email/phone checks pass.

Name check for the names the world bible adds (web search, 2026-11-02): no matches for the HQ and warehouse streets in their cities or for the four officers in logistics roles. Generated names that were replaced: "Ridgeline Avenue" (close to Chicago's Ridgeland Avenue), "Ridgeline Distribution Center" (close to projects of Ridgeline Property Group, a real industrial developer active near Joliet) and "Ironwood Loop" (reuses a rejected catalog name).

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
- `value` is the canonical rendering (`$1,250.00`, `Net 30`, `04/15/2026`, `2%`); `aliases` lists accepted alternatives (`$1,250`, `thirty (30) days`, `April 15, 2026`). A `money` value is the amount alone: units such as "per hour" and qualifiers go in `statement` and `aliases`. A whole-dollar amount must list its short form as an alias, and a date its long form.
- ≥ 8 facts carry `differsFrom` linking the same `category` in another document of the same type with **different** values (penalties, payment terms, liability caps across MSAs; detention rates across carriers; accrual rates across policies).
- ≥ 4 facts have `isException: true`.
- No two documents share the same `value` for `penalty` or `liability_cap`.
- Every `entityIds` entry exists in `world.json`.
- No ISO dates, URLs, emails, phone numbers or blocklisted names. Names with a legal suffix (LLC, Inc., Corp., Ltd.) in a `statement` must come from `world.json`; a name without a suffix is not detected.

`pnpm datagen:registry` makes one call per document type and writes the file even when a rule fails, because a failing registry is fixed by hand rather than regenerated. If the file exists, the script writes nothing unless given `--force`, which would discard the hand edits.

The committed registry was generated on 2026-11-02 (`gpt-5-mini`, 162 facts) and hand-edited: money values reduced to the amount, liability caps made unique across documents, TONU facts moved from `penalty` to `fee`, fuel surcharges and the hazmat fee aligned across documents, and `differsFrom` links between incomparable facts removed. RAG-012 added one `date` fact to each of the 14 carrier, HR and SOP documents that had none (176 facts now) and rewrote four values such as `15.00 days per year` that the writer model would not reproduce. RAG-013 added the effective date of `rate-accessorials`, the last document without one (177 facts now), and lowered the FTL minimum charge from `$950.00` to `$350.00`, since `$950.00` was above the linehaul of every dry van lane and made the per-mile rates meaningless.

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
pnpm datagen:check              → calls both providers, parses JSON with zod, prints the prompt version
pnpm datagen:world              → data/world.json              (prompt 01 part A; then hand-edit)
pnpm datagen:registry           → data/registry.json           (prompt 01 part B)  + validate-registry
pnpm datagen:docs               → data/generated/md/<slug>.md  (prompt 02; 20 documents)
pnpm datagen:rate-sheets        → data/generated/rate-sheets/<slug>.json + md/<slug>.md  (prompt 03; JSON tables → Markdown tables)
pnpm datagen:render             → data/corpus/<type>/<slug>.docx
pnpm datagen:validate           → report: every alias found? format checks, blocklist
pnpm datagen:questions          → data/eval/questions.json     (prompt 04; different model than docs)
```

Document, registry and rate-sheet generation use the `openai` client (`src/server/llm/client.ts`) with `DATAGEN_MODEL` (default `gpt-5-mini`); question generation uses a different model family through `src/server/llm/judge.ts` (`@anthropic-ai/sdk`, `DATAGEN_QUESTIONS_MODEL`, default `claude-haiku-5-5`). Sampling parameters are left at provider defaults. Outputs are committed; regeneration is deliberate (`--force`).

`pnpm datagen:rate-sheets` writes the 4 rate sheets. The JSON in `data/generated/rate-sheets/` is the source, and hand edits go there: an existing file is only checked and its Markdown rewritten, so a run costs nothing once all files exist. Before a file is written it must pass: the exact columns for its kind, no `|` in a cell, every fact value verbatim, money with cents, no blocklist, URL, email or phone hits, and the rules for its kind. LTL and FTL: lane ids, cities and miles match `world.json`, all 10 lanes present (dry van and reefer rows on FTL), minimum charges and lane rates in their cells, longer lanes cost at least as much, reefer ≥ dry van, and on FTL a longer lane never has a higher rate per mile. Accessorials: all 10 services, with fact amounts in the Charge cell. Fuel surcharge: 12–16 steps, contiguous to the cent and strictly increasing, with each fact tier as one step. The tiers in the registry end at an open-ended `$4.50 and above`, so the other steps sit below `$3.00`. `--force`, `--only` and the retries work as in `pnpm datagen:docs`.

The committed rate sheets were generated on 2026-11-02 (`gpt-5-mini`) and hand-edited to remove notes that repeated the table or leaked prompt wording. No check reads the notes for meaning, so they need the manual review in §7.

`pnpm datagen:docs` writes the 20 MSA, carrier, HR and SOP documents. Before a file is written it must pass: first line `# <title>`, ≥ 8 `##` sections, 1,200–2,400 words, every fact present, every money, date and percent token found in the facts or the world slice, an exception word in the sentence of an exception fact whose statement has one, no blocklist, URL, email or phone hits. A failing document is retried up to 2 times with the errors in the prompt, and if it still fails it is not written. An existing file is only checked, so a run costs nothing once all files exist; `--force` regenerates and `--only <slug>` limits the run to one document. The report prints each exception sentence for review, and standalone numbers above 12 outside the allowed set as warnings.

Scripts run with `tsx --conditions=react-server`, so `server-only` resolves outside Next.js, and import `scripts/data-gen/load-env.ts` first, so `.env.local` is parsed the way Next.js parses it. `src/env.ts` still validates every app variable, so `SESSION_SECRET` and `DEMO_ACCOUNTS_JSON` must be set for the scripts too. Zod schemas are in `data-gen/schemas/*.ts`.

### 5.1 Markdown → DOCX (`docx` library, `scripts/data-gen/render.ts`)

- `#` → Title, `##` → Heading 1, `###` → Heading 2 (real `HeadingLevel` styles so mammoth emits `<h1>/<h2>`), paragraphs, numbered lists, Markdown tables → Word tables with a header row.
- Header: company name; footer: document id (the slug). Letter size.
- Rate sheets: prompt 03 returns JSON tables; the script converts them to Markdown tables inside a short document (title, intro, one `##` section per table, notes) and renders the same way.
- Lists: `-` and `1.` items, plus one nested level indented by spaces (a block mixes one nested kind only). A numbering gap in the source fails the run, because Word renumbers a list itself.
- Each source line of a paragraph becomes its own Word paragraph, because address and signature blocks in the generated Markdown have no trailing spaces. A `---` line becomes a paragraph border with no text. A line of underscores stays text.
- Anything the renderer cannot represent (a `####` heading, a table row with the wrong cell count, a missing or second `#` title) fails the run instead of being dropped. Inline Markdown such as `**bold**` is not parsed; the corpus has none.
- Deterministic: the same Markdown gives the same bytes, regardless of the clock, time zone or what else the run rendered. The `docx` library stamps the clock into `docProps/core.xml` and into every zip entry, so `markdown-docx.ts` repacks the file with `jszip`, using fixed dates and sorted entries.

`pnpm datagen:render` needs no API keys and costs nothing; `--only <slug>` limits the run to one document. `pnpm datagen:render --fixtures` rebuilds `tests/fixtures/*.docx` from the `.md` next to them, and a unit test fails if a committed fixture differs from a fresh render.

### 5.2 Validation script (`pnpm datagen:validate`)

For every document in the catalog:
1. Extract text with the **same parser ingestion uses** (`src/server/ingest/parsers/docx.ts`), so validation proves what retrieval will see — including table cells.
2. Normalize: collapse whitespace, unify quotes/dashes, lowercase.
3. For each fact of the document: pass if its `value` (without a final period) or any `alias` (normalized) is an exact substring. The value counts because prompt 02 asks for it verbatim and forbids restating it in another format, so a document rarely contains the aliases of a sentence-long value.
4. Format checks on the whole text: every date matches `\b\d{2}/\d{2}/\d{4}\b` (ISO dates, other slash dates such as `4/1/2026` and written dates such as `April 1, 2026` fail); every amount matches `\$\d{1,3}(,\d{3})*(\.\d{2})?`; no `€`/`£`; no `http`, `@`, or phone-like patterns.
5. Blocklist: `data-gen/blocklist.txt` (real carriers, 3PLs, retailers, manufacturers the model tends to produce).
6. Output: `data/generated/validation-report.json` with per-document pass/fail, missing fact ids and errors, committed with the corpus (it has no timestamp, so a rerun on the same corpus changes nothing); non-zero exit on any failure. CI runs it on every push rather than only on `data/**` changes, because a parser change can break it too; it needs no API keys and takes seconds.

If a fact is reported missing only because of formatting, add an alias to the registry instead of loosening the match. The checks are in `scripts/data-gen/corpus-checks.ts`, tested in `tests/unit/validate.test.ts`.

## 6. Eval questions — `data/eval/questions.json`

Schema per question: `slug`, `category`, `split`, `role`, `question`, `expectedAnswer` (null for refusals), `expectedDocSlugs[]`, `sourceFactIds[]`, `distractorDocSlugs[]`, `reviewed`, `notes`.

Generation rules (prompt 04):
- The writer model is **different** from the document writer; it receives facts and world entities, **not** document text.
- Paraphrase: the question must not contain more than 4 consecutive words from `statement`; ≥ 40% of questions use indirect phrasing (role-play: "a customer asks how long they have to pay…").
- Comparison questions name two documents and expect both values; distractor questions name a similar document with a different value.
- `no_answer` questions are plausible for the role but absent from all documents (e.g., CEO salary, a customer not in the world).
- `other_role` questions are answerable from documents the role cannot access; the expected behavior is refusal with zero retrieved chunks from those documents. Chunks the role may read still come back (ADR-0019).
- Split assignment is stratified by category (dev ≈ 30%).

Manual review checklist (each question, `reviewed: true` only when all hold): unambiguous; one correct answer from the facts; the expected document(s) really contain it; role is right; no leakage of the exact fact wording; dates/amounts in US format; category correct.

Counts: direct 16, comparison 6, exception 5, no_answer 8, other_role 5 = 40. Split: dev 12 / test 28.

`pnpm datagen:questions` makes one call per category, one at a time, with the same retries as `pnpm datagen:docs`. The set is written only when every check passes. An existing file is only checked, so a run costs nothing and hand edits are kept; `--force` regenerates and would discard them. The checks are in `scripts/data-gen/question-checks.ts`:

- Schema, exact counts, unique slugs, no question asked twice.
- Every document slug is in the catalog, no document is both expected and a distractor, and every source fact exists, belongs to an expected document, and every expected document has one.
- `direct|comparison|exception`: the role can read every expected document. `other_role`: the role can read none of them, and `expectedAnswer` is null. `no_answer`: no documents, no facts, and `expectedAnswer` is null.
- No 5-gram shared between the question and the `statement` of a source fact. An amount or date counts as one word, and a hyphen splits a word.
- `direct`: one document and one fact. `comparison`: two documents of the same type, two facts linked by `differsFrom` and at least one distractor. `exception`: a fact with `isException`.
- `expectedAnswer` contains the value or an alias of each source fact, except `text` facts, whose values are often sentences an answer rewords.
- The question has 6–25 words. Date and money formats, blocklist, URLs, emails and phones.
- Split: the dev count of each category is direct 5, comparison 2, exception 2, no_answer 2, other_role 1. Within a category, dev takes the first questions by a hash of the slug, so the split does not depend on the order of the file.

No check can tell whether a question is indirect (the ≥ 40% rule), whether a `no_answer` question is really absent from the documents, or whether a `text` answer is right. These are for the manual review.

The committed set was generated on 2026-11-02 (`claude-haiku-5-5`) and reviewed by an AI agent the same day (`reviewed: true`): 14 questions were edited, one of them replaced. Results are in `data/eval/review.md`. `data/VERSION` is `2026.11-1`.

## 7. Review effort

Target: 8 minutes per document (checklist skim, not a full read), 2 minutes per question. ≈ 4.5 h total across M1, spread over two evenings.
