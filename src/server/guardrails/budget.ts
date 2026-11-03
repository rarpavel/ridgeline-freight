import 'server-only';

import { eq, sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';

import { env } from '@/env';
import { AppError } from '@/lib/errors';
import { usageDaily } from '@/server/db/schema/guardrails';
import { logger } from '@/server/logger';

import { failClosed, type GuardrailDeps } from './limits';

export type DailyUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Checked before the model call and added to after it, so requests already running can pass the
 * budget by what they use. The provider's spend cap is the hard limit behind this one.
 */
export async function assertDailyBudget({
  db,
  clock = () => new Date(),
}: GuardrailDeps): Promise<void> {
  const [usage] = await failClosed(() =>
    db
      .select({ inputTokens: usageDaily.inputTokens, outputTokens: usageDaily.outputTokens })
      .from(usageDaily)
      .where(eq(usageDaily.day, utcDay(clock()))),
  );
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (tokens >= env.DAILY_TOKEN_BUDGET) {
    logger.warn(
      { route: '/api/chat', tokens, budget: env.DAILY_TOKEN_BUDGET },
      'guardrail.budget_exhausted',
    );
    throw new AppError('budget_exhausted', 'Demo budget for today is spent.');
  }
}

/** Never throws: the answer has already reached the client, and lost usage must not undo that. */
export async function recordDailyUsage(
  { inputTokens, outputTokens, costUsd }: DailyUsage,
  { db, clock = () => new Date() }: GuardrailDeps,
): Promise<void> {
  try {
    await db
      .insert(usageDaily)
      .values({ day: utcDay(clock()), requests: 1, inputTokens, outputTokens, costUsd })
      .onConflictDoUpdate({
        target: usageDaily.day,
        set: {
          requests: sql`${usageDaily.requests} + 1`,
          inputTokens: sql`${usageDaily.inputTokens} + ${inputTokens}`,
          outputTokens: sql`${usageDaily.outputTokens} + ${outputTokens}`,
          costUsd: sql`${usageDaily.costUsd} + ${costUsd}`,
        },
      });
  } catch (err) {
    const cause = err instanceof DrizzleQueryError ? err.cause : err;
    logger.error({ err: cause }, 'guardrail.usage_failed');
  }
}
