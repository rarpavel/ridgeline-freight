import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { env } from '@/env';
import { db } from '@/server/db/client';
import { logger } from '@/server/logger';

export const dynamic = 'force-dynamic';

const ROUTE = '/api/health';
const DB_TIMEOUT_MS = 8_000;
const GIT_TIMEOUT_MS = 1_000;
// TODO(RAG-022): replace with the version from the prompt loader.
const PROMPT_VERSION = 'n/a';

const run = promisify(execFile);

async function checkDb(): Promise<'ok' | 'error'> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`SELECT 1 timed out after ${DB_TIMEOUT_MS} ms`)),
      DB_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([db.execute(sql`SELECT 1`), timeout]);
    return 'ok';
  } catch (err) {
    logger.error({ err, route: ROUTE, durationMs: Date.now() - startedAt }, 'health.db_error');
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

async function readGitSha(): Promise<string> {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { timeout: GIT_TIMEOUT_MS });
    return stdout.trim();
  } catch (err) {
    logger.warn({ err, route: ROUTE }, 'health.git_sha_unavailable');
    return 'unknown';
  }
}

export async function GET() {
  const [dbStatus, gitSha] = await Promise.all([checkDb(), readGitSha()]);
  const isHealthy = dbStatus === 'ok';

  return NextResponse.json(
    {
      status: isHealthy ? 'ok' : 'error',
      db: dbStatus,
      embeddingModel: env.EMBEDDING_MODEL,
      promptVersion: PROMPT_VERSION,
      gitSha,
    },
    { status: isHealthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
