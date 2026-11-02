# ADR-0016: Demo passwords shown on the login page come from DEMO_ACCOUNTS_JSON

Status: Accepted · Date: 2026-11-02

## Context
The login page publishes the four demo passwords (`SECURITY.md §1`, §3), but bcrypt hashes cannot be reversed and `DEMO_ACCOUNTS_JSON` held only `id`, `role` and `passwordHash`. The plaintext has to live somewhere the server can read.

## Options
1. Hard-code the passwords in the login page: rotating them needs a commit, and the repository rule is that credentials stay out of commits.
2. A second env variable with the plaintext: two variables that must change together and can drift.
3. An optional `demoPassword` field next to `passwordHash` in `DEMO_ACCOUNTS_JSON`.

## Decision
Option 3. One variable stays the single source for an account, `pnpm hash-password` generates the whole value, and the server component passes only `id`, `role` and `demoPassword` to the client.

## Consequences
- The hash protects nothing while the plaintext sits next to it; it is kept so the login path stays production-shaped. A real deployment would drop `demoPassword` and the table on the login page, with no change to the login route.
- An account without `demoPassword` can still sign in, and the login page shows a dash for it.
- `DEMO_ACCOUNTS_JSON` must never be logged. It is read only through `src/env.ts`, which does not print rejected values.
