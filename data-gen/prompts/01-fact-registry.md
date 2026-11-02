# Prompt 01 — World Bible and Fact Registry

## Purpose
Produce (A) the fictional world shared by all documents and (B) the fact registry: 5–8 concrete, verifiable facts per document that every document is later written from. The registry is the ground truth for validation and evaluation.

## Model requirements
Strong instruction following and JSON output (`gpt-5-mini` or better). JSON mode / structured output enabled. Two calls: A once (then hand-edited and frozen), B once per document type (5 calls) to keep outputs under ~6k tokens each.

## Inputs
- `{{catalog_json}}` — `data/catalog.json` entries for the document type being processed (slug, title, type, roles, format).
- `{{world_json}}` — `data/world.json` (for part B).
- `{{doc_type}}` — one of `msa | carrier_agreement | hr_policy | sop | rate_sheet`.

## Part A — world bible prompt

```
You are creating a consistent fictional world for a document corpus about "Ridgeline Freight, LLC",
a mid-size US freight and logistics company headquartered in Chicago, Illinois (founded 2009,
~450 employees, 3 warehouses in the Midwest, dry van / reefer / LTL / drayage services).

Produce a JSON object with:
- "company": name, hq address (fictional street number on a real Chicago street name is NOT allowed —
  invent a street name), city "Chicago", state "IL", zip starting with "606", founded "2009",
  fiscalYearStart "01/01", 4 officers with titles and fictional names.
- "customers": exactly the customers listed below (ids and names given), each with industry, city,
  state (Midwest states only), typical commodity, annual volume band ("<1k", "1k-5k", "5k-20k" loads/year).
- "carriers": exactly the carriers listed below, each with equipment list, home state, fleet size band.
- "lanes": 10 lanes between Midwest cities with realistic road miles (±10%).
- "warehouses": 3 warehouses with fictional addresses and dock counts.
- "glossary": short definitions of detention, layover, accessorial, TONU, lumper fee, OS&D, hazmat, reefer.

Hard rules:
- All names of people, companies, streets, phone numbers and emails must be fictional. Do not use any
  real logistics, retail, food or manufacturing company name. Do not use real people's names.
- Dates in MM/DD/YYYY. Money in USD with two decimals ($1,250.00).
- Output JSON only, no commentary.

Customers (id | name): {{customers_list}}
Carriers (id | name): {{carriers_list}}
```

## Part B — fact registry prompt

```
You are generating the fact registry for the "{{doc_type}}" documents of Ridgeline Freight, LLC.
The world bible below is the only source of entity names, addresses and lanes. Use it verbatim.

WORLD:
{{world_json}}

DOCUMENTS (slug | title | roles):
{{catalog_json}}

For EACH document produce 5–8 facts. A fact is one concrete, checkable statement with a single
canonical value that will appear verbatim in the document text.

Fact object:
{
  "factId": "<slug>#<two-digit sequence>",
  "docSlug": "<slug>",
  "category": "payment_terms|penalty|liability_cap|term_and_termination|notice_period|rate|fee|threshold|policy_rule|date|party|exception|other",
  "statement": "one sentence stating the fact in business English, naming the document's subject",
  "value": "canonical rendering exactly as it must appear in the document",
  "aliases": ["alternative renderings that would also count as present"],
  "valueType": "money|days|percent|date|number|text",
  "sectionHint": "where in a typical document this belongs, e.g. 'Payment Terms'",
  "isException": false,
  "differsFrom": ["factId of the same category in a similar document, when values intentionally differ"],
  "entityIds": ["ids from WORLD referenced by this fact"]
}

Requirements for the whole set:
1. Values are concrete: amounts in USD with two decimals ($12,500.00), dates MM/DD/YYYY, terms as
   "Net 30" / "Net 45", percentages like "1.5%", periods like "48 hours" or "15 business days".
2. Similar documents must DIFFER on comparable facts: for msa — late delivery penalty, payment terms,
   liability cap, termination notice; for carrier_agreement — detention rate, free time, cargo liability,
   payment terms; for hr_policy — accrual rates, eligibility thresholds; for sop — time windows,
   temperature ranges, escalation thresholds; for rate_sheet — minimum charges, per-mile rates, fuel
   surcharge steps. Mark these with "differsFrom". No two documents share the same value for the same
   category.
3. Include exceptions: at least one fact per document type with "isException": true and a qualifier
   such as "except for hazmat shipments", "unless the Customer provides written notice", "excluding
   federal holidays". Put the qualifier inside "statement". When "valueType" is "money", "value" is
   the amount alone ($45.00): units such as "per hour" and qualifiers go in "statement" and "aliases".
4. US context: Illinois governing law and venue (Cook County), at-will employment, PTO accrual per pay
   period, FMCSA-style hours-of-service language without citing regulation numbers, accessorial and
   detention charges, lumper fees, TONU.
5. "aliases" must include the obvious alternatives: "$12,500.00" → ["$12,500", "twelve thousand five
   hundred dollars"]; "Net 30" → ["net thirty (30) days", "thirty (30) days from the invoice date"];
   dates → ["April 15, 2026"].
6. No real companies, people, addresses, phone numbers or emails. Use WORLD entities only.
7. Output: {"version": "{{dataset_version}}", "facts": [ ... ]} — JSON only.
```

## Output schema
`data-gen/schemas/registry.schema.json` (see `docs/03-data/SYNTHETIC_DATA.md §3`).

## Validation rules (`pnpm datagen:validate-registry`)
- Schema valid; 5–8 facts per slug; all slugs from the catalog present.
- ≥ 8 `differsFrom` links across the full registry; ≥ 4 `isException`.
- Regex checks: money `^\$\d{1,3}(,\d{3})*\.\d{2}$`; date `^\d{2}/\d{2}/\d{4}$`; no ISO dates.
- Aliases: a whole-dollar amount lists its short form (`$12,500`), a date its long form (`April 15, 2026`).
- `differsFrom` targets exist, share the category and the document type, and hold another value.
- Every `entityIds` entry exists in `world.json`; names with a legal suffix (LLC, Inc., Corp., Ltd.) in statements appear in the world bible.
- Blocklist (`data-gen/blocklist.txt`) hits = 0.

## Example (one valid fact)
```json
{
  "factId": "msa-harbor-point-foods#03",
  "docSlug": "msa-harbor-point-foods",
  "category": "penalty",
  "statement": "Ridgeline Freight credits Harbor Point Foods $250.00 per shipment delivered more than 24 hours late, except for shipments delayed by documented weather events.",
  "value": "$250.00",
  "aliases": ["$250", "two hundred fifty dollars ($250.00)"],
  "valueType": "money",
  "sectionHint": "Service Levels and Remedies",
  "isException": true,
  "differsFrom": ["msa-lakeshore-retail#03"],
  "entityIds": ["cust-harbor-point-foods"]
}
```
