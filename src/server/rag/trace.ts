import 'server-only';

import { and, eq } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';

import type { TraceDetails } from '@/lib/trace-details';
import type { SessionUser } from '@/server/auth/require';
import type { db as appDb } from '@/server/db/client';
import { requestTraces, type TraceRetrieval } from '@/server/db/schema/request-traces';
import { logger } from '@/server/logger';

import type { RetrievalResult } from './retrieve';

export type RequestTrace = typeof requestTraces.$inferInsert;

export function toTraceRetrieval(
  { candidates, bestSim, ftsMatches, vectorUnavailable }: RetrievalResult,
  simFloor: number,
): TraceRetrieval {
  return {
    candidates: candidates.map((candidate) => ({ ...candidate, cited: false })),
    bestSim,
    simFloor,
    ftsMatches,
    vectorUnavailable,
  };
}

/** Own traces only, admin any (SECURITY.md §4): another account's trace reads as a missing one. */
export async function findTraceDetails(
  { id, user }: { id: string; user: SessionUser },
  { db }: { db: typeof appDb },
): Promise<TraceDetails | null> {
  const [trace] = await db
    .select({
      id: requestTraces.id,
      gate: requestTraces.gate,
      retrieval: requestTraces.retrieval,
      promptVersion: requestTraces.promptVersion,
      model: requestTraces.model,
      inputTokens: requestTraces.inputTokens,
      outputTokens: requestTraces.outputTokens,
      costUsd: requestTraces.costUsd,
      ttftMs: requestTraces.ttftMs,
      latencyMs: requestTraces.latencyMs,
      refused: requestTraces.refused,
      refusalReason: requestTraces.refusalReason,
      citationsValid: requestTraces.citationsValid,
      citationsDropped: requestTraces.citationsDropped,
      error: requestTraces.error,
    })
    .from(requestTraces)
    .where(
      and(
        eq(requestTraces.id, id),
        user.role === 'admin' ? undefined : eq(requestTraces.account, user.account),
      ),
    );
  return trace ?? null;
}

/** Never throws: the answer has already reached the client, and a lost trace must not undo that. */
export async function writeTrace(trace: RequestTrace, { db }: { db: typeof appDb }): Promise<void> {
  try {
    await db.insert(requestTraces).values(trace);
  } catch (err) {
    // A failed query's own message carries its parameters, the question and the answer among them.
    const cause = err instanceof DrizzleQueryError ? err.cause : err;
    logger.error({ err: cause, traceId: trace.id }, 'chat.trace_failed');
  }
}
