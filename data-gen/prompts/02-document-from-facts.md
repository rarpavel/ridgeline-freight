# Prompt 02 — Document from Facts

## Purpose
Write one complete document (MSA, carrier agreement, HR policy or SOP) in US business English from its registry facts and the world bible, so that every fact appears verbatim and no other numbers, dates or amounts are invented.

## Model requirements
Long-form writing with strict constraint following; 3–5k output tokens. `gpt-5-mini` or better. Plain text/Markdown output (no JSON mode). One call per document.

## Inputs
- `{{title}}`, `{{slug}}`, `{{doc_type}}` — from the catalog.
- `{{world_slice_json}}` — company block plus only the entities referenced by this document's facts.
- `{{facts_json}}` — this document's facts (full objects).
- `{{effective_date}}` — MM/DD/YYYY chosen by the script (also listed as a `date` fact).
- `{{type_guidance}}` — the block for the document type from §"Type guidance" below.

## Prompt

```
Write the full text of "{{title}}" for Ridgeline Freight, LLC in US business English.
Document type: {{doc_type}}. Effective date: {{effective_date}}.

WORLD (use names and addresses exactly as given; invent nothing else):
{{world_slice_json}}

FACTS (every fact must appear, with its "value" rendered EXACTLY as written, in the section suggested by
"sectionHint" or a sensible neighbor; spread them across different sections rather than grouping them):
{{facts_json}}

Format:
- Markdown. Line 1: "# {{title}}". Then "## 1. <Section>", "## 2. <Section>", … with numbered
  subsections "### 2.1 <Subsection>" where natural. Use the numbering in headings only once (no
  duplicated "1." inside the heading text).
- 1,400–2,200 words. 8–14 top-level sections.
- Short paragraphs; numbered lists for procedures; a simple Markdown table only where the type guidance
  asks for one.
- Dates MM/DD/YYYY, money as $1,250.00, percentages as 1.5%.

Content rules:
1. Include ALL facts, faithful in meaning, with the value string verbatim. Do not restate a fact's value
   a second time with a different format.
2. Do NOT add any numbers, dates, dollar amounts, percentages, durations or quantities that are not in
   FACTS or WORLD. Where boilerplate normally has a number (e.g., "thirty (30) days' notice"), use
   qualitative wording instead ("reasonable prior written notice") unless the number is a fact.
3. Add realistic boilerplate appropriate for the type (definitions, scope, responsibilities, force
   majeure, governing law "State of Illinois", venue "Cook County, Illinois", notices, entire agreement,
   signatures with titles but placeholder signature lines) so the facts are not on the surface.
4. Exceptions: when a fact has "isException": true, state the exception in the same sentence as the rule
   it qualifies.
5. No real companies, people, addresses, phone numbers, emails, URLs, or regulation numbers.
6. Do not include any text that instructs a reader or a system to do something outside the document
   (no "note to AI", no instructions).
7. Output only the document text.

{{type_guidance}}
```

## Type guidance (inserted as `{{type_guidance}}`)

- **msa**: parties (Ridgeline Freight, LLC as "Carrier"/"Provider" and the customer as "Customer"), term, services and service levels, rates by reference to a rate sheet, accessorial charges, payment terms, late delivery remedies, claims and cargo liability cap, insurance, indemnification, termination, confidentiality, governing law, notices, signatures.
- **carrier_agreement**: parties (Ridgeline as "Broker"/"Shipper", the carrier as "Carrier"), equipment, compliance and safety representations, detention/layover/free time, cargo liability, insurance minimums, payment terms and quick-pay option, non-solicitation, termination, governing law.
- **hr_policy**: purpose, scope and eligibility, policy statement, procedures (accrual, requests, approvals), exceptions, compliance/at-will reminder, questions/contacts (titles only), revision history line with the effective date.
- **sop**: purpose, scope, roles and responsibilities, definitions, step-by-step procedure (numbered), exceptions and escalation, records and KPIs, revision history. One simple table (thresholds or checklist) is appropriate.

## Output
Markdown text saved to `data/generated/md/<slug>.md`.

## Validation rules (`pnpm datagen:validate` after rendering, plus pre-render checks)
- First line is `# <title>`; ≥ 8 `##` headings; word count 1,200–2,400.
- Every fact alias present (normalized match) in the Markdown **and** in the extracted text after rendering.
- No number tokens outside the allowed set (facts, world, section numbers, page footers): the script extracts all `\$[\d,\.]+`, `\d{2}/\d{2}/\d{4}`, `\d+(\.\d+)?%` and standalone numbers > 12 and reports any not in the allowed set (manual review of the report; standalone numbers are advisory).
- Blocklist hits = 0; no `http`, `@`, phone-like patterns.

## Example (excerpt of valid output)
```
# Master Service Agreement — Harbor Point Foods, Inc.

## 1. Parties and Effective Date
This Master Service Agreement (the "Agreement") is entered into as of 04/15/2026 by and between Ridgeline Freight, LLC, an Illinois limited liability company ("Carrier"), and Harbor Point Foods, Inc., a Wisconsin corporation ("Customer").

## 4. Service Levels and Remedies
### 4.3 Late Delivery Credits
Carrier shall credit Customer $250.00 per shipment delivered more than 24 hours after the scheduled delivery window, except for shipments delayed by documented weather events.
```
