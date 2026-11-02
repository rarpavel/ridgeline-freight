# ADR-0010: Document generation with the docx library only

Status: Accepted · Date: 2026-11-02

## Context
Documents must be real DOCX with heading styles so mammoth yields headings; rate sheets need tables. v2 also rendered PDFs and simulated scans; the MVP drops PDF and OCR.

## Decision
Markdown → DOCX via the `docx` npm library (Heading styles, tables). Rate sheets are DOCX documents whose tables come from prompt 03's JSON. The validator proves every registry alias appears in the text extracted by the ingestion parser.

## Consequences
- One parser (`mammoth`) in ingestion, no browser or image libraries.
- PDF text parsing and scanned-PDF OCR stay in the roadmap (`SPEC_REVIEW.md` F-14, F-15 hold the design).
