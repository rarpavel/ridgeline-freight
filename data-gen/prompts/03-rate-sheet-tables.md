# Prompt 03 — Rate Sheet Tables

## Purpose
Generate the structured content of a rate sheet (lanes, minimum charges, per-mile rates, accessorial fees or fuel surcharge steps) as JSON tables that the renderer turns into Markdown tables inside a DOCX, consistent with the registry and the world bible.

## Model requirements
JSON output, arithmetic consistency (rates × miles plausible). `gpt-5-mini` or better. One call per rate sheet.

## Inputs
- `{{sheet_slug}}`, `{{sheet_title}}`, `{{sheet_kind}}` — `ltl | ftl | accessorials | fuel_surcharge`.
- `{{world_lanes_json}}`, `{{world_company_json}}`.
- `{{facts_json}}` — this sheet's facts (minimum charges, specific lane rates, fee amounts, surcharge steps).
- `{{effective_date}}`.

## Prompt

```
Produce the content of "{{sheet_title}}" for Ridgeline Freight, LLC as JSON for rendering.
Kind: {{sheet_kind}}. Effective date: {{effective_date}}.

WORLD lanes and company (use verbatim): {{world_lanes_json}} {{world_company_json}}
FACTS (each "value" must appear verbatim in a cell or in "notes"): {{facts_json}}

Output JSON:
{
  "title": "{{sheet_title}}",
  "effectiveDate": "{{effective_date}}",
  "intro": "one or two sentences on applicability (no numbers unless from FACTS)",
  "tables": [
    { "title": "string", "columns": ["Lane", "Origin", "Destination", "Miles", "Min Charge", "Rate / Mile"],
      "rows": [["lane-chi-mke", "Chicago, IL", "Milwaukee, WI", "92", "$950.00", "$2.85"]] }
  ],
  "notes": ["string"]
}

Rules by kind:
- ltl: one table, columns [Lane, Origin, Destination, Miles, "<500 lb", "500-1,999 lb", "2,000-4,999 lb", "Min Charge"]; one row per lane in WORLD, with the WORLD id in the Lane cell; rates per cwt as $xx.xx, falling as weight rises; the minimum charge from FACTS on every row; a lane rate from FACTS goes in that lane's "<500 lb" cell.
- ftl: one table, columns [Lane, Origin, Destination, Miles, Equipment, Min Charge, Rate / Mile]; for each of the 10 lanes in WORLD, one "Dry van" row and one "Reefer" row, with the WORLD id in the Lane cell; the minimum charge from FACTS on every row; a lane rate from FACTS goes in that lane's "Dry van" row.
- accessorials: one table, columns [Service, Unit, Charge, Notes]; include detention, layover, TONU, lumper, liftgate, inside delivery, residential, hazmat handling, redelivery, storage. A service with an amount in FACTS has exactly that amount in its Charge cell.
- fuel_surcharge: one table, columns [DOE Diesel Price Range (per gallon), Surcharge (% of linehaul)] with 14 contiguous steps, written as "$3.00–$3.49" and, for the last step only, "$4.50 and above". Each surcharge tier in FACTS is one step with exactly that range and percentage, and is also one note using its "value". Add ten lower steps, $0.10 wide, from "$2.00–$2.09" to "$2.90–$2.99", with surcharges below the first FACTS tier. Surcharges strictly increase with price. Include a note on the weekly update basis without naming a real index URL.

General rules:
1. Money as $1,234.56, always with cents; percentages as 12.5%; miles as integers; weights with "lb".
2. All FACTS values appear verbatim at least once in a cell or note. A fact with a condition or exception
   states it in the same table row or note as its value. Other numbers must be plausible and internally
   consistent (longer lanes cost more; reefer ≥ dry van).
3. ≤ 25 rows per table; ≤ 3 tables. No "|" character or line break in a cell.
4. No real company names, URLs or addresses.
5. JSON only.
```

## Output schema
```json
{ "type": "object", "required": ["title","effectiveDate","intro","tables","notes"],
  "properties": {
    "title": {"type":"string"}, "effectiveDate": {"type":"string","pattern":"^\\d{2}/\\d{2}/\\d{4}$"},
    "intro": {"type":"string"},
    "tables": {"type":"array","maxItems":3,"items":{"type":"object","required":["title","columns","rows"],
      "properties":{"title":{"type":"string"},"columns":{"type":"array","items":{"type":"string"},"minItems":2,"maxItems":8},
                    "rows":{"type":"array","maxItems":25,"items":{"type":"array","items":{"type":"string"}}}}}},
    "notes": {"type":"array","items":{"type":"string"}} } }
```

## Validation rules
- Schema valid; every row has exactly `columns.length` cells.
- Every fact value found in cells or notes (normalized), since a short alias such as `$2` would match `$22.50`.
- Money/date regexes as in prompt 01; lane ids, city pairs and miles match `world.json`.
- Minimum charges and lane rates sit in the cells named above; reefer ≥ dry van; longer lanes cost more.
- Fuel steps are contiguous and strictly increasing, and each FACTS tier is one step.
- After rendering to DOCX and re-parsing with the ingestion parser (mammoth tables → Markdown), every fact alias is still found.

## Example (valid output, truncated)
```json
{ "title": "Accessorial Fee Schedule (2026)", "effectiveDate": "01/01/2026",
  "intro": "These charges apply to services beyond standard dock-to-dock transportation under the applicable Master Service Agreement.",
  "tables": [ { "title": "Accessorial Charges", "columns": ["Service", "Unit", "Charge", "Notes"],
    "rows": [ ["Detention (after free time)", "per hour", "$65.00", "Billed in 15-minute increments"],
              ["Truck Ordered Not Used (TONU)", "per occurrence", "$250.00", "Applies to cancellations after dispatch"] ] } ],
  "notes": ["Free time for live loads is 2 hours, except for hazmat shipments, which receive 3 hours."] }
```
