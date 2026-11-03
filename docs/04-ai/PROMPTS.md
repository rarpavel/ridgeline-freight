# Prompts Index

Every prompt used by the project: purpose, inputs, outputs, model requirements, version. Runtime prompts (used by the app and the eval CLI) live in `prompts/`; data-generation prompts live in `data-gen/prompts/`. Each prompt file in `data-gen/prompts/` contains the full text, output schema, validation rules and an example.

Last updated: 2026-11-03

## Versioning

- File name carries the version: `prompts/rag-system.v3.md`. A change = a new file with the next version; old files stay.
- `src/server/prompts/load.ts` exports `loadPrompt(name, version)`, which returns `{ name, version, hash, text }`; `hash` = first 8 hex chars of sha256 of the file. `formatPromptVersion(prompt)` gives the form recorded in traces and eval runs: `rag-system@v1#1a2b3c4d`.
- `src/server/prompts/render.ts` exports `renderPrompt(template, variables)`, which throws on a variable with no value.
- LLM clients: `src/server/llm/client.ts` (`openai`) and `src/server/llm/judge.ts` (`completeWithClaude`, CLI only). Both rely on the SDK's retries for 429 and 5xx.
- Data-generation prompts are versioned the same way but their outputs are committed, so a version bump means regenerated data and a new `data/VERSION`.

## Runtime prompts (`prompts/`)

| Name | File | Purpose | Inputs | Output | Model |
|------|------|---------|--------|--------|-------|
| rag-system | `prompts/rag-system.v2.md` (`rag-system@v2#7d16849e`; rule 8 changed, ADR-0021) | System prompt for answering with citations, refusal, conflict handling, injection resistance | role name, context blocks `[1..n]`, question | Markdown answer with `[n]` citations, or `NO_ANSWER: …` | `gpt-5-mini` |
| judge | `prompts/judge.v1.md` | Score correctness and faithfulness with rationale | question, expected answer, facts, system answer, cited chunks | strict JSON (`correctness`, `faithfulness`, `refusalCorrect`, `rationale`) | `claude-haiku-5-5` |
| refusal-text | `src/server/rag/refusal.ts` (constant, not a prompt) | Fixed user-facing refusal | — | "I couldn't find this in the documents available to your role." | — |

Source texts for `rag-system` and `judge` are authored in `data-gen/prompts/05-rag-system-prompt.md` and `06-judge.md`; the build copies the prompt block into the current `prompts/*.v<N>.md` (task in E5/E8 keeps them in sync; a unit test asserts equality).

## Data-generation prompts (`data-gen/prompts/`)

| # | File | Purpose | Inputs | Output | Model |
|---|------|---------|--------|--------|-------|
| 00 | section A of `01-fact-registry.md` | World bible | catalog | `world.json` | `gpt-5-mini` |
| 01 | `01-fact-registry.md` | Fact registry for all documents | world, catalog | `registry.json` (schema in `SYNTHETIC_DATA.md`) | `gpt-5-mini` |
| 02 | `02-document-from-facts.md` | One document from its facts | world slice, doc entry, facts | Markdown document | `gpt-5-mini` |
| 03 | `03-rate-sheet-tables.md` | Rate sheet tables | world lanes, facts | JSON tables → Markdown tables → DOCX | `gpt-5-mini` |
| 04 | `04-eval-questions.md` | Eval questions by category with paraphrase and distractors | registry, world, catalog, counts | `questions.json` | **different family** (`claude-haiku-5-5`) |
| 05 | `05-rag-system-prompt.md` | Production system prompt | — | copied to `prompts/rag-system.v3.md` | — |
| 06 | `06-judge.md` | Judge rubric | — | copied to `prompts/judge.v1.md` | — |

## Rules for all prompts

- English only; explicit output schema; one example of valid output.
- Never include real company names or addresses as examples (use placeholders from `world.json`).
- Prompts that produce JSON ask for **JSON only** and are parsed with `zod` schemas; a parse failure retries once with the validation error appended.
- Prompts are plain Markdown with `{{variable}}` placeholders rendered by `src/server/prompts/render.ts` (simple string replacement, no template engine).
