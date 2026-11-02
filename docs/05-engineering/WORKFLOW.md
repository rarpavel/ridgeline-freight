# Workflow

Branches, commits, pull requests, Definition of Ready / Done, and CI gates. The Notion Tasks database is the queue; this file is how a task moves from Ready to Done.

Last updated: 2026-11-02

## 1. Branches

- `main` is always green and deployable; Vercel deploys `main` to production.
- One branch per task: `rag-012-structural-chunker` (`<task-id>-<slug>`). Rebase on `main` before opening the PR; squash-merge.
- No long-lived feature branches; a task that cannot merge within 2 evenings is too big and is split in Notion.

## 2. Commits

- Conventional Commits: `feat(rag): add RRF fusion with per-document cap`, `fix(auth): …`, `docs: …`, `chore(ci): …`, `data: regenerate registry v2026.11-2`, `test: …`.
- Scopes: `app, rag, ingest, db, auth, guardrails, eval, datagen, ui, ci, docs, infra`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` when an AI agent wrote the change.
- Secrets never in commits; `.env*` is git-ignored and `.env.example` holds placeholders only.

## 3. Pull request checklist

- [ ] Title `RAG-012: <imperative summary>`; body links the Notion task and the docs section it implements.
- [ ] Acceptance criteria from the task are copied into the PR and each is checked with evidence (test name, screenshot, trace id).
- [ ] New dependency → one line of justification.
- [ ] Docs updated (which files) or "no doc change" stated.
- [ ] Preview deployment link opened once and the changed screen checked.
- [ ] CI green (typecheck, lint, unit, integration).

Solo project: PRs are self-reviewed with the checklist; an AI reviewer pass (`/code-review`) is run on PRs touching `src/server/rag`, `src/server/auth`, `src/server/guardrails`.

## 4. Definition of Ready (a task may move Backlog → Ready)

- Context, goal, in/out of scope, implementation notes, 3–7 acceptance criteria and a test plan are filled (template in Notion).
- Dependencies (`Blocked by`) are Done.
- Estimate ≤ 4 h; otherwise split.
- The relevant docs section exists and is linked.

## 5. Definition of Done (Done requires all)

- [ ] Acceptance criteria met with evidence in the PR.
- [ ] Typecheck, lint, tests green in CI; new behavior has tests at the level `TESTING.md` prescribes.
- [ ] Documentation updated (named files) and `Last updated` bumped.
- [ ] Deployed to preview; to production when the task is on `main` (automatic).
- [ ] Notion task: status Done, PR link, and any decision recorded in Decisions (ADR) or Risks.

## 6. Picking the next task / blocked tasks

Automated path: run `/next-task` (skill in `.claude/skills/next-task/SKILL.md`) in a fresh Claude Code session; it applies the rules below, stops at In review, and closes the task only after the human merges.

- Take the lowest `Order` task in `Ready` whose `Blocked by` are Done.
- If blocked: set `Blocked`, write the blocker in the task, create or update a Risk, and take the next unblocked task; never start two tasks in parallel.
- Scope change discovered mid-task → finish the smallest useful increment, open a new task for the rest.

## 7. Releases and milestones

- A milestone is "done" when its exit criteria (Notion Milestones) are checked on production and the README milestone log has a dated entry.
- Tag `m0` … `m4` on `main` at milestone completion.
