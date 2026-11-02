---
name: next-task
description: Take the next unblocked task from the Ridgeline RAG Notion board (or a named task like RAG-012), move it through In progress → PR → In review with mandatory checks, and record the result back in Notion. Use when the user says "next task", "/next-task", "take RAG-0xx", or asks to continue the plan.
---

# next-task — one task from the Notion board to a reviewed PR

You drive exactly one task per invocation through the workflow in `docs/05-engineering/WORKFLOW.md`. The human reviews and merges; you never merge on your own unless told to. Work in English in code and docs; Notion content is in Ukrainian.

## Notion coordinates

- Tasks data source: `collection://d05d938d-b148-46dc-b120-1018530a994e` (database `https://app.notion.com/p/5e6dcf0bc9a5477fad023646e1a015fb`)
- Milestones: `collection://1cfff20c-efbe-41cc-b2d0-fc7f233977f6` · Risks: `collection://9d1e4c3e-1afe-47c8-8ff9-7678befca07d` · Decisions: `collection://3c1394d9-15be-47e8-8a8f-8911e43b257c`
- Task properties: `Title`, `userDefined:ID` (RAG-0xx), `Status` (Backlog | Ready | In progress | In review | Blocked | Done), `Order`, `Estimate`, `Epic`, `Milestone`, `Blocked by`, `Blocks`, `Docs`.
- Read rows with `notion-query-data-sources` in `rows` mode (SQL mode is rate-limited); read a task page with `notion-fetch`; change status/properties with `notion-update-page` (`update_properties`); append notes with `notion-update-page` (`insert_content`, position end).

## Step 0 — preconditions (stop if any fails)

- `git status` is clean and you are on `main`, up to date with origin (`git pull --ff-only`). If not, say so and stop.
- `.env.local` exists (needed for integration tests and any ingest/eval step). Never print its values.
- Notion MCP tools respond (`notion-get-self`). If not, tell the user to connect Notion and stop.

## Step 1 — pick the task

1. If the user named a task (`/next-task RAG-012`), fetch that row. Otherwise query all rows sorted by `Order` ascending and pick the first with `Status` in {Ready, Backlog} whose every `Blocked by` page has `Status = Done`.
2. If nothing qualifies: list the first three candidates with what blocks them and stop.
3. If another task is already `In progress`, report it and ask whether to resume it or pick a new one; do not run two tasks in parallel.

## Step 2 — start

1. Set `Status = In progress` on the task.
2. Fetch the task page and read every section: Контекст, Мета, Що входить / не входить, Нотатки, Acceptance criteria, План тестування, Definition of Done. Read every document listed in `Docs` and the relevant parts of `CLAUDE.md`.
3. Create the branch `git checkout -b rag-<nnn>-<short-slug>` (slug from the title, kebab-case, ≤ 5 words).
4. Keep the task list in this session (update_plan) mirroring the acceptance criteria.

## Step 3 — implement

- Follow `CLAUDE.md` rules and `docs/05-engineering/CONVENTIONS.md`. Stay inside "Що входить"; anything in "Що не входить" is out of scope even if convenient.
- Tests first where "План тестування" names them; the `rbac-leak` test and any security-related behavior must have tests, not assertions in prose.
- New dependency → one-line justification in the PR; prefer versions listed in `docs/00-review/SPEC_REVIEW.md §7`.
- If the task turns out larger than its estimate: finish the smallest useful increment that satisfies as many acceptance criteria as possible, and append a note to the task page listing what remains; propose a follow-up task to the user instead of silently expanding scope.
- If you must make a design decision not covered by the docs, write it as a short ADR under `docs/02-architecture/adr/` and add a row to the Decisions database (Status Accepted, Link = file path).

## Step 4 — verify (mandatory, all must pass)

```
pnpm typecheck && pnpm lint && pnpm test
pnpm test:integration        # needs: docker compose up -d
```

- Walk through every acceptance criterion and collect evidence: test name, command output, screenshot path, trace id. An unmet criterion means the task is not done — do not reword the criterion.
- Update the documentation files named in the Definition of Done and bump their `Last updated` line; say "no doc change" explicitly otherwise.
- If a step needs a production action (migration, ingest, env change per `docs/06-ops/DEPLOYMENT.md`), **do not run it** — describe the exact command in the PR and ask the user.

## Step 5 — pull request and review hand-off

1. Commit with Conventional Commits (`feat(rag): …`, `fix(auth): …`, `data: …`, `docs: …`); end the message with the attribution line required by this environment.
2. Push and open the PR: title `RAG-<nnn>: <imperative summary>`; body = link to the Notion task, the acceptance criteria copied as a checklist with evidence per item, "Docs updated: …", "New dependencies: …", "Production steps needed: …".
3. Set `Status = In review`, append to the task page a short note: PR link, what was verified, anything left open.
4. Report to the user in a few lines: what was built, PR link, what they need to check or run. **Stop here.** Do not merge.

## Step 6 — closing (only on the user's explicit "merge" / "done")

1. Merge (squash) when CI is green, delete the branch, `git checkout main && git pull`.
2. Run any production step the user approved (migration, ingest) and the smoke check from `docs/06-ops/DEPLOYMENT.md §5`.
3. Set `Status = Done`. If the task closes a milestone, check its exit criteria, set the milestone `Status = Done`, tag `m<N>` and update the Hub page's current milestone.

## Blocked

If something outside this task prevents completion (missing credential, upstream bug, unclear requirement): set `Status = Blocked`, append the reason to the task page, add or update a row in Risks with a mitigation, and tell the user what you need. Then, if asked, pick the next unblocked task.

## Never

- Never move a task to Done without a merged PR and green CI.
- Never edit prompt files in place (add `v<N+1>`), never put the role filter anywhere but SQL, never log secrets, never commit `.env*`.
- Never run eval with the judge or production ingest without the user's go-ahead (they cost money and touch production data).
