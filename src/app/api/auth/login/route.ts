import { getIronSession } from 'iron-session';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { AppError } from '@/lib/errors';
import { verifyCredentials } from '@/server/auth/accounts';
import { sessionOptions, type SessionData } from '@/server/auth/session';
import { db } from '@/server/db/client';
import { clientIp } from '@/server/guardrails/limits';
import { reserveLoginAttempt } from '@/server/guardrails/rateLimit';
import { assertSameOrigin, errorResponse } from '@/server/http';
import { logger } from '@/server/logger';

const ROUTE = '/api/auth/login';

const bodySchema = z.object({
  account: z.string().min(1).max(64),
  // Bounded so a huge body cannot keep bcrypt busy; bcrypt reads only the first 72 bytes anyway.
  password: z.string().min(1).max(200),
});

async function parseBody(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const result = bodySchema.safeParse(body);
  if (!result.success) throw new AppError('validation', 'Enter an account and a password.');
  return result.data;
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { account, password } = await parseBody(request);

    const refundAttempt = await reserveLoginAttempt(clientIp(request), { db });
    const verified = await verifyCredentials(account, password);
    if (!verified) {
      // The submitted account is user input, so it stays out of the log.
      logger.warn({ route: ROUTE }, 'auth.login_failed');
      throw new AppError('unauthorized', 'Incorrect account or password.');
    }
    await refundAttempt();

    const response = NextResponse.json(
      { account: verified.id, role: verified.role },
      { headers: { 'Cache-Control': 'no-store' } },
    );
    const session = await getIronSession<SessionData>(request, response, sessionOptions);
    session.account = verified.id;
    session.role = verified.role;
    session.issuedAt = Date.now();
    await session.save();

    logger.info({ route: ROUTE, account: verified.id, role: verified.role }, 'auth.login');
    return response;
  } catch (err) {
    return errorResponse(err, ROUTE);
  }
}
