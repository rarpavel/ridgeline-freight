# ADR-0015: No branch protection while the repository is private

Status: Accepted · Date: 2026-11-02

## Context
RAG-006 asks that a PR with a red `ci` check cannot be merged, through branch protection on `main`. GitHub refuses this with HTTP 403 for a private repository on the free plan; it needs a public repository or GitHub Pro. The owner decided to keep the repository private and not to pay for Pro.

## Decision
Run without branch protection. `ci` still runs on every PR and reports failures, and the owner, as the only person merging, checks that it is green before merging (`WORKFLOW.md §3`).

## Consequences
- A red PR can be merged by hand, so "`main` is always green" rests on discipline rather than enforcement. The risk is recorded in Notion Risks as Accepted.
- The RAG-006 criterion that a red PR cannot be merged stays unmet, by the owner's decision.
- If the repository goes public or moves to Pro, enable branch protection with `ci` as the required check and supersede this ADR.
