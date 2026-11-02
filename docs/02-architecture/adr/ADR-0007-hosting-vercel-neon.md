# ADR-0007: Vercel Hobby + Neon Free; CLIs from the developer machine

Status: Accepted · Date: 2026-11-02

## Context
Free hosting for a public demo that must not go dark. Vercel functions cap at 300 s (Hobby). Supabase Free pauses after a week of inactivity; Neon Free scales to zero after 5 minutes but stays available.

## Decision
Vercel Hobby for the app (non-commercial personal use), Neon Free for Postgres (pooled `-pooler` URL for the app, direct URL for migrations and CLIs). Ingestion, evaluation and migrations run from the developer's machine. Local dev and CI use Docker `pgvector/pgvector:pg17`.

## Consequences
- First request after idle pays a Neon cold start; the health check and UI retry.
- No preview databases or migration workflows (roadmap). If the demo becomes paid client work, move to Vercel Pro.
