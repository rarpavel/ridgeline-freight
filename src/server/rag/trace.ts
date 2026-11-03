import 'server-only';

import { DrizzleQueryError } from 'drizzle-orm/errors';

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
