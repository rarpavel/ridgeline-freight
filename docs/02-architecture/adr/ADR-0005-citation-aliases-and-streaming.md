# ADR-0005: Per-request citation aliases and a typed SSE protocol

Status: Accepted · Date: 2026-11-02

## Context
Chunk UUIDs in prompts cost tokens and get mangled; citations can only be validated after generation, but the UI streams.

## Decision
Context blocks are numbered `[1]..[n]` per request (single-turn, no history); the server maps aliases to chunk ids, validates after generation, drops unknown aliases and logs them. SSE events: `meta → delta* → citations → done | error`. Refusals start with `NO_ANSWER:`.

## Consequences
- Client upgrades `[n]` to chips at the end of the stream; dropped markers disappear.
- No internal ids leak to the browser except in the `citations` event (chunk ids are not secrets; access is enforced on the viewer endpoint).
