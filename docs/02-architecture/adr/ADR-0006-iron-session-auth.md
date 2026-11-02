# ADR-0006: Credentials login with iron-session for four demo accounts

Status: Accepted · Date: 2026-11-02

## Context
Auth.js is now part of Better Auth; `next-auth@5` is still beta. The demo needs exactly four fixed accounts with roles and no user management.

## Options
1. `next-auth` v4/v5 Credentials provider.
2. Better Auth (needs user/session tables).
3. `iron-session` encrypted cookie + bcrypt hashes in env + a tiny login route.

## Decision
Option 3. ~100 lines, no beta dependency, no tables, sessions are encrypted httpOnly `SameSite=Lax` cookies; login attempts go through the same rate limiter.

## Consequences
- No OAuth/SSO (out of scope). Rotating `SESSION_SECRET` logs everyone out (fine).
- Authorization is checked in `proxy.ts` for redirects and again in every handler.
