# ADR-0020: The eval runner reads document access roles without a role filter

Status: Accepted · Date: 2026-11-03

## Context
CLAUDE.md rule 1 puts a role filter in every chunk and document query. `leakCount` (`EVALUATION.md §2`) has to tell whether a retrieved chunk came from a document outside the question's role. A query under that same filter can only ever return allowed documents, so it would report 0 leaks whatever retrieval did.

## Decision
`loadAccessRoles` in `src/server/eval/runner.ts` selects `slug` and `access_roles` of all documents with no role filter. It is the one exception to rule 1. It selects no document text or chunks, nothing it returns reaches a prompt or a user, and it runs only in the eval CLI. A retrieved document missing from this lookup counts as a leak.

Rejected: reading the allowed list from `data/catalog.json`. The check would then compare retrieval with a file, not with what the database enforces, and would miss a document ingested with the wrong roles.

## Consequences
- Answering a question still goes through the filtered queries of `answerQuestion`; the exception covers only the check on them.
- `rbac-leak.test.ts` stays the guarantee that holds on every PR. `leakCount` adds the same check on real embeddings, for `other_role` questions only.
