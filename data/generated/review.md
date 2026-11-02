# Corpus review (RAG-016)

Review of the 24 generated documents against the checklist below. Reviewed by an AI agent on 2026-11-02 by reading the full Markdown source of every document and comparing it with `data/registry.json`. Edits were made in the Markdown, or in `data/generated/rate-sheets/*.json` for rate sheets; DOCX files are rendered from those sources.

Checklist: US business language; no real names; exceptions in the same sentence as the rule; readable tables; no notes from the writer model; US date and amount formats; signature blocks with titles and no real people.

Status: `ok` (no change), `fixed` (edited by hand), `regenerated` (rewritten by the model). No document was regenerated, and no registry fact changed.

| Document | Status | What changed |
|---|---|---|
| msa-harbor-point-foods | fixed | Reworded the repeated "Payment Terms: Net 30" label in §5.2 and §5.3 |
| msa-lakeshore-retail | ok | |
| msa-prairie-wind-mfg | fixed | Governing law sentence was missing "the laws of" |
| msa-marlowe-finch-medical | fixed | Removed raw world fields (industry, commodity, volume band); reworded the payment terms sentence |
| msa-northline-auto | fixed | §3.2 cross-reference pointed to Section 5; rate sheets are in Section 4 |
| msa-cedar-valley-beverages | fixed | Removed an empty sentence before the termination notice in §10.1 |
| carrier-brightwater | fixed | Reworded raw "fleet size band" field; removed a trailing space after a `---` line |
| carrier-ashgrove-haulage | ok | |
| carrier-juniper-bend | fixed | Removed a writer note about the exception sentence in §5.2; rewrote raw carrier fields; carrier name line in the signature block held a title |
| carrier-granite-fork-intermodal | fixed | "State of NE (as represented by Carrier)" became "Nebraska" |
| hr-pto-holidays | fixed | Reworded the governing law sentence; removed "by title" from the contacts section |
| hr-remote-hybrid-work | fixed | Fixed capitalization of the remote allowance and the possessive in "business days' notice"; removed "by title only"; replaced a non-breaking hyphen |
| hr-travel-expense | fixed | Removed doubled lead-ins in §7 and §10; reworded "courts of venue"; removed "titles only" from §19 |
| hr-conduct-at-will | fixed | Fixed capitalization of "progressive discipline"; removed "by title" and "(title)" from the contacts section |
| hr-driver-hours-safety | fixed | Removed writer notes ("stated as", "in the same sentence as stated") in §5, §6, §11, §13, §15; removed "by title only"; replaced `[signature line]` placeholders |
| hr-attendance-leave | fixed | Repaired the broken federal holiday sentence in §8; removed "by title only" |
| sop-inbound-receiving | fixed | Removed repeated warehouse names in §6, §7, §10; replaced non-breaking hyphens; simplified the table separator; replaced `[signature line]` placeholders |
| sop-outbound-pick-pack | fixed | Removed a duplicated cutoff sentence and a writer note in §6; used "This SOP" as the subject; reworded the "qualitative" KPI; replaced non-breaking hyphens |
| sop-hazmat-handling | fixed | Reworded raw "docks 12" and carrier fields; removed "qualitative" and "to be defined" from the KPIs; used "This SOP" as the subject; replaced `[signature line]` placeholders |
| sop-osd-exceptions | fixed | Reworded raw "docks" fields; removed the doubled lumper sentence and a stray table label; used "This SOP" as the subject; added a claim file check to §14 |
| rate-ltl-midwest | ok | |
| rate-ftl-dry-van | ok | |
| rate-accessorials | ok | |
| rate-fuel-surcharge | fixed | Shortened note 6, which repeated note 5 |

## Left as is

- **Rules that differ across documents.** Fees and terms that differ between documents come from the registry, and many are deliberate distractors for the eval set. One is not marked as deliberate: the condition for the $200.00 hazmat handling fee differs between `sop-hazmat-handling` (except Juniper Bend Logistics shipments) and `rate-accessorials` (unless paperwork arrives 24 hours before pickup), and neither fact has a `differsFrom` link. Eval questions on this fee should name the document (RAG-017/018).
- **Contract sections in handbooks.** Some HR documents have notice, force majeure and entire agreement sections that are unusual for a handbook. They are harmless and fill the required length, so they stay.
- **Officer names.** All officer names are fictional and come from `data/world.json`.
