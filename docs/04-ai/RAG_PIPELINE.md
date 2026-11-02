# RAG Pipeline

Ingestion (parsing, chunking, context prefixes, embeddings) and query handling (hybrid retrieval, fusion, gate, generation, citation validation). Code lives in `src/server/ingest/` and `src/server/rag/`; the web route and the CLIs call the same functions. Values below are defaults; tuned values are recorded in `eval_runs.retrieval_config`.

Last updated: 2026-11-02

## 1. Ingestion

### 1.1 Parser (`src/server/ingest/parsers/docx.ts`)

`parseDocx(buffer)` returns `{ text, sections }`. `mammoth.convertToHtml` with a style map (the renderer writes `#` as Title, `##` as Heading 1, `###` as Heading 2; Heading 3 also becomes `###`), then a small HTML walker produces normalized text, one line per block and no blank lines:

```
# Master Service Agreement — Harbor Point Foods, Inc.
## 1. Definitions
1.1 "Accessorial Charges" means ...
## 4. Service Levels
### 4.3 Late Delivery Penalties
For each Shipment delivered more than 24 hours after ...
| Lane | Origin | Destination | Min Charge | Rate / Mile |
| --- | --- | --- | --- | --- |
| L-01 | Chicago, IL | Milwaukee, WI | $425.00 | $2.85 |
```

Tables become Markdown tables (the first row is the header; a `|` in a cell is escaped as `\|`); lists become `-`/`1.` lines, nested items indented by three spaces. Inline formatting, page headers and footers, rules and empty paragraphs are dropped, and whitespace inside a line collapses to one space. `document_texts.sections` has one flat entry per heading of any level, in order: `ref` is the leading number (`4.3`, or `''` for an unnumbered heading such as the title or `Notes`), `title` is the rest of the heading, and `text.slice(charStart, charEnd)` is the heading line plus its body up to the line before the next heading, so a `##` section does not include its `###` subsections and sections never overlap. The same parser is used by the data validator (`SYNTHETIC_DATA.md §5.2`).

### 1.2 Structural chunker (`src/server/ingest/chunker.ts`, `CHUNKER_VERSION = 'v2'`)

1. Split the normalized text into sub-units at `##`/`###` headings; a numbered clause (`4.3 …`) inside a section starts a sub-unit, and a table is a sub-unit of its own. Heading lines stay in `content`.
2. A chunk is one sub-unit if ≤ 600 tokens (`js-tiktoken`, `o200k_base`); sub-units > 600 tokens split at paragraph boundaries with an overlap of at most 50 tokens, cutting at word boundaries only inside a paragraph too long for one chunk.
3. Chunks < 50 tokens (ADR-0018) merge with the following sub-unit of the same `##` section. What is still short then merges with a neighbouring chunk across sections: the next one first, and into a table only if no text chunk fits (ADR-0017). A chunk stays below 50 tokens only if no neighbour has room, or if the whole document is that short.
4. Tables: one chunk per table, whole up to 1,080 tokens even above the 600 limit; a short heading or note may merge into it, up to 1,200 tokens. A larger table splits by rows; every part after the first repeats the header rows in `context_prefix`, not in `content`, so offsets still hold (ADR-0017).
5. Each chunk records `section_ref` (`4.3`, or `null` above the first section), `section_title` (the `###` or `##` title), `char_start/char_end`, `token_count`. `text.slice(char_start, char_end) === content` for every chunk. A merged chunk takes these from its first sub-unit with body text.
6. `context_prefix = "<title> — <H2 title> › <H3 title>"` (parts that exist).
7. Text sent to the embedder and FTS = `context_prefix + "\n" + content`.

Actual on the 24-document corpus: 423 chunks, 14–25 per contract, policy or SOP (mean ≈ 90 tokens), 2–3 per rate sheet; no table reaches the split limit.

### 1.3 Embeddings (`src/server/llm/embeddings.ts`)

- `openai.embeddings.create({ model: EMBEDDING_MODEL, input: batch })`, batches of 64; the SDK retries 429/5xx with exponential backoff (3 retries, set in `llm/client.ts`); assert the number of vectors and `vector.length === 1536` before insert; `embedding_model` stored per chunk.

### 1.4 Idempotency and CLI (`src/server/ingest/pipeline.ts`, `scripts/ingest.ts`)

`pnpm ingest [--force] [--only <slug>]`:
- At the start, reject the run if `chunks` holds another `embedding_model`; only `--force` without `--only` may replace it (`DATA_MODEL.md §6`).
- For each catalog entry: compute sha256; if `documents.checksum` and `chunker_version` match and there is no `--force` → skip.
- Otherwise parse, chunk and embed outside any transaction, so a failed embedding call writes nothing and no connection waits on the network. Then in one transaction: upsert `documents`, replace `document_texts`, delete+insert `chunks` (with embeddings).
- A failed document keeps its previous version and the run moves on to the next one.
- Prints a summary table (slug, chunks, tokens, embedded, skipped, failed) and exits non-zero on any failure.
- `documents.effective_date` stays `NULL`: nothing reads it yet.

Actual on the 24-document corpus: 423 chunks, about 39k tokens; the first run takes about 10 s, a run that skips everything about 1 s.

## 2. Query handling (`src/server/rag/`)

```
answerQuestion({ question, session }) →
  guardrails → embedQuery → retrieve → fuse → gate → buildPrompt → generate(stream) → validateCitations → trace
```

### 2.1 Retrieval (`retrieve.ts`)

`retrieveCandidates({ questionEmbedding, question, roles }, { db })` runs one read-only `REPEATABLE READ` transaction, so a concurrent ingest cannot show the two statements different chunks, with two statements (`DATA_MODEL.md §3`):
- Vector: exact cosine scan on `chunks.embedding` with `documents.access_roles && $roles`, top-20, `sim = 1 - distance`.
- FTS: `websearch_to_tsquery('english', question)`, `ts_rank_cd(tsv, query)`, same role filter, top-20. Zero matches is a normal outcome.
- Both order ties by `chunks.id`, so a run is reproducible. Empty `roles` returns nothing. A failed query becomes `AppError('db_error')`, without the query parameters in its message.

`retrieve({ question, roles }, { db, embed })` embeds the question before the transaction, calls `retrieveCandidates` and `fuseRrf`, and returns `{ candidates, bestSim, ftsMatches, vectorUnavailable }`.
- If the embedding call fails: a `retrieval.vector_unavailable` warning, FTS-only, `vectorUnavailable = true`, `bestSim = null`; the trace stores the flag as `retrieval.vectorUnavailable`.

Candidates hold ids and scores only; `prompt.ts` needs the chunk text and document title, and that query must carry the same role filter.

### 2.2 Fusion (`fuse.ts`)

Reciprocal Rank Fusion, `k = 60`: `score(c) = Σ_lists 1 / (k + rank_list(c))`, ranks starting at 1. Sort descending, exact ties by the better vector rank, then FTS rank; take the top-8 allowing at most 3 chunks per document (`perDocCap`), filling up from lower-ranked chunks of other documents. `fuseRrf` returns every candidate in that order, because the trace records them all; each keeps `vectorRank`, `vectorSim`, `ftsRank`, `ftsScore`, `rrf` (rank and score `null` for a list it is not in) and `inPrompt`.

### 2.3 Gate (`gate.ts`)

```
refuseWithoutLlm = (bestVectorSim < SIM_FLOOR || vectorUnavailable) && ftsCandidates.length === 0
```

Default `SIM_FLOOR = 0.30` (placeholder; calibrated on the dev split in M3 by comparing best-sim distributions of answerable vs. `no_answer` questions, stored in `retrieval_config.simFloor`). A gate refusal returns the fixed refusal text and makes no model call.

### 2.4 Prompt assembly (`prompt.ts`)

- System prompt: `prompts/rag-system.v1.md` (authored in `data-gen/prompts/05-rag-system-prompt.md`).
- First user message: context blocks in fused order:
  ```
  [1] Document: Harbor Point Foods MSA · Section 4.3 Late Delivery Penalties
  <<<
  ...chunk content...
  >>>
  ```
  followed by the question (≤ 500 chars). Single turn; no history. A later part of a split table needs the header rows from `context_prefix` in its block (§1.2).
- `max_tokens: 700`.

### 2.5 Generation (`generate.ts`)

`openai.chat.completions.create({ stream: true, stream_options: { include_usage: true }, ... })`; tokens forwarded as `delta` SSE events; usage from the final chunk, fallback to `js-tiktoken` counts.

### 2.6 Citation validation (`citations.ts`)

- Regex `\[(\d{1,2})\]` over the full answer; valid if `1 ≤ n ≤ inPrompt.length`; unknown aliases are removed and counted in `citations_dropped`.
- A refusal is detected when the answer starts with `NO_ANSWER:`; the marker is stripped and the UI shows the refusal state.
- If `!refused && valid.length === 0` → converted to a refusal (`reason = 'no_valid_citations'`); the generated text is replaced by the fixed refusal text and kept in the trace.

### 2.7 Trace (`trace.ts`)

One `request_traces` row per request (candidates with scores, gate, prompt version, model, tokens, cost from `config/pricing.json`, TTFT, latency, citation counts, refusal, error), written after `done`/`error` and awaited before the handler returns.

## 3. Tuning knobs

| Knob | Default | Where | Tuned on |
|------|---------|-------|----------|
| `vectorTopK` / `ftsTopK` | 20 / 20 | `retrieval_config` | dev split |
| `rrfK` | 60 | `retrieval_config` | fixed |
| `finalK` / `perDocCap` | 8 / 3 | `retrieval_config` | dev split |
| `simFloor` | 0.30 | env `SIM_FLOOR` | dev split |
| chunk size | 50–600 tokens | `CHUNKER_VERSION` | dev split |
| `max_tokens` | 700 | env | fixed |

Roadmap (not MVP): HNSW index with iterative scans at larger corpus sizes; reranker between fusion and gate; query condensation for follow-ups.
