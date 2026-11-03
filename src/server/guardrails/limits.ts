import 'server-only';

import { createHash } from 'node:crypto';

import { DrizzleQueryError } from 'drizzle-orm/errors';

import { AppError } from '@/lib/errors';
import type { db as appDb } from '@/server/db/client';

export type GuardrailDeps = {
  db: typeof appDb;
  /** Windows and days follow this clock, so tests can move time without touching the database. */
  clock?: () => Date;
};

const UNKNOWN_IP = 'unknown';
const DB_UNAVAILABLE = 'The document store is waking up, retry in a few seconds.';

/**
 * The first `x-forwarded-for` entry. Vercel overwrites this header, so a client cannot choose its
 * own value there. Without the header (local runs) all requests share one bucket.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || UNKNOWN_IP;
}

/** Limit keys hold this hash, so raw addresses are never stored (SECURITY.md §7). */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

/**
 * The limits are checked before anything is spent, so they fail closed: a database that cannot count
 * requests stops the request. A failed query's own message carries its parameters.
 */
export async function failClosed<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (err) {
    const cause = err instanceof DrizzleQueryError ? err.cause : err;
    throw new AppError('db_error', DB_UNAVAILABLE, { cause });
  }
}
