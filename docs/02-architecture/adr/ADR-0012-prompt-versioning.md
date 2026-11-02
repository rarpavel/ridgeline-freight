# ADR-0012: Prompts as versioned files with content hashes

Status: Accepted · Date: 2026-11-02

## Context
Metrics are meaningless without knowing which prompt produced them.

## Decision
Runtime prompts live in `prompts/<name>.v<N>.md`; the loader exposes `{ name, version, hash, text }`; `request_traces.prompt_version` and `eval_runs.prompt_version` store `name@vN#<8-char hash>`. Changing a prompt means adding a new version file; old versions stay for reproducibility.

## Consequences
- Prompt changes are visible in PR diffs and traceable in metrics.
