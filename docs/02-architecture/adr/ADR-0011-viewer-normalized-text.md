# ADR-0011: Document viewer renders normalized text, not the original file

Status: Accepted · Date: 2026-11-02

## Context
Highlighting a cited chunk inside a rendered DOCX or PDF is complex and format-specific.

## Decision
Ingestion stores each document's normalized text with section headings (`document_texts`); chunks carry `char_start/char_end` into it. The viewer renders that text, scrolls to and highlights the range, and offers the original file for download.

## Consequences
- Deterministic highlighting with one code path, independent of the source format.
- Not pixel-faithful; a pdf.js viewer with highlights is a documented later enhancement.
