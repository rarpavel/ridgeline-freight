import 'server-only';

import { and, eq, sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';

import { env } from '@/env';
import { AppError } from '@/lib/errors';
import { rateLimits } from '@/server/db/schema/guardrails';
import { logger } from '@/server/logger';

import { failClosed, hashIp, type GuardrailDeps } from './limits';

const HOUR_MS = 60 * 60 * 1000;
const LOGIN_FAILURES_PER_HOUR = 5;

/** Fixed windows on whole UTC hours, the ones the chat banner counts down to (ADR-0008). */
function windowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
}

async function countRequest(
  key: string,
  start: Date,
  { db }: Pick<GuardrailDeps, 'db'>,
): Promise<number> {
  return failClosed(async () => {
    const [row] = await db
      .insert(rateLimits)
      .values({ key, windowStart: start, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimits.key, rateLimits.windowStart],
        set: { count: sql`${rateLimits.count} + 1` },
      })
      .returning({ count: rateLimits.count });
    if (!row) throw new Error('The rate limit query returned no row');
    return row.count;
  });
}

/**
 * The IP goes first: a client already over its IP limit then stops using up the quota of the shared
 * demo account it signs in with.
 */
export async function assertChatRateLimit(
  { account, ip }: { account: string; ip: string },
  { db, clock = () => new Date() }: GuardrailDeps,
): Promise<void> {
  const start = windowStart(clock());
  const limits = [
    { scope: 'ip', key: `ip:${hashIp(ip)}`, limit: env.RATE_LIMIT_IP_PER_HOUR },
    { scope: 'account', key: `acct:${account}`, limit: env.RATE_LIMIT_ACCOUNT_PER_HOUR },
  ];
  for (const { scope, key, limit } of limits) {
    if ((await countRequest(key, start, { db })) > limit) {
      logger.warn({ route: '/api/chat', account, scope, limit }, 'guardrail.rate_limited');
      throw new AppError('rate_limited', 'You have reached the hourly question limit.');
    }
  }
}

/**
 * Counts the attempt before bcrypt runs, so parallel guesses cannot all pass a check made before any
 * of them failed. Returns the function that gives the attempt back once the password proves right,
 * which leaves only failures in the count.
 */
export async function reserveLoginAttempt(
  ip: string,
  { db, clock = () => new Date() }: GuardrailDeps,
): Promise<() => Promise<void>> {
  const key = `login:${hashIp(ip)}`;
  const start = windowStart(clock());
  if ((await countRequest(key, start, { db })) > LOGIN_FAILURES_PER_HOUR) {
    logger.warn({ route: '/api/auth/login', scope: 'login' }, 'guardrail.rate_limited');
    throw new AppError(
      'rate_limited',
      'Too many failed sign-in attempts. Try again at the start of the next hour.',
    );
  }
  return async () => {
    // The password was right, so a lost refund must not fail the sign-in: it costs one attempt.
    try {
      await db
        .update(rateLimits)
        .set({ count: sql`${rateLimits.count} - 1` })
        .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, start)));
    } catch (err) {
      // A failed query's own message carries its parameters.
      const cause = err instanceof DrizzleQueryError ? err.cause : err;
      logger.warn({ err: cause, route: '/api/auth/login' }, 'guardrail.refund_failed');
    }
  };
}
