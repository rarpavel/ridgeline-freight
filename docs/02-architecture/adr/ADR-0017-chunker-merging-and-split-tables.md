# ADR-0017: Chunker merging across sections and split-table headers

Status: Accepted · Date: 2026-11-02

## Context
RAG-019 asks for chunks of 120–600 tokens, merging short sub-units only within their section. Most sections of the corpus are far below 120 tokens (often 38 of 41 in a contract), and some whole `##` sections are too, so that rule alone leaves chunks under the minimum.

RAG-019 also asks for two things that cannot both hold for a split table: `text.slice(charStart, charEnd) === content` for every chunk, and a repeated header row. Repeated rows do not occur contiguously in the source text. No table in the current corpus is large enough to split.

## Decision
- Short chunks merge first within their `##` section, then with a neighbouring chunk across sections, preferring the next chunk and a text chunk over a table.
- A chunk is flushed as soon as it reaches 120 tokens, which keeps chunks small and citations precise. This gives a mean of about 175 tokens, below the 300–600 target in `SPEC.md`; the size is tuned on the dev split in RAG-033.
- `content` is always an exact slice of the text. Parts of a split table after the first carry the header rows in `context_prefix`, which reaches the embedder and FTS. Prompt assembly must add them to the context block for such a part.
- Tables stay whole up to 1,080 tokens. Above that they split by rows, because a table without a limit could outgrow the prompt budget. The remaining 120 tokens up to 1,200 leave room for a short heading or note to merge in.

## Consequences
- A chunk can span several sections and is cited by the first one with body text, so its `section_ref` names only the start of the range. Eval scores at document level, so hit rate is unaffected.
- Contracts get 10–13 chunks rather than the 20–40 first estimated, because a 2,000-token document cannot produce more at a 120-token minimum.
- Viewer highlighting works for every chunk, including split tables, because offsets are always exact.
- A short last section such as `Notes` can sit in the same chunk as a table.
