import 'server-only';

import { NextResponse } from 'next/server';

import { AppError } from '@/lib/errors';
import { logger } from '@/server/logger';

/**
 * Refuses cross-site POSTs to routes that write the session cookie. SameSite=Lax does not cover
 * these: login and logout work without an incoming cookie. Browsers always send Origin on POST, so
 * a request without one is not a cross-site browser request.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin === null) return;
  const host =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    new URL(request.url).host;
  if (URL.parse(origin)?.host !== host) {
    throw new AppError('forbidden', 'This request came from another site.');
  }
}

/** Maps an error to the JSON shape every route returns; only `safeMessage` reaches the client. */
export function errorResponse(err: unknown, route: string): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.safeMessage } },
      { status: err.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  logger.error({ err, route }, 'route.internal_error');
  return NextResponse.json(
    { error: { code: 'internal', message: 'Something went wrong.' } },
    { status: 500, headers: { 'Cache-Control': 'no-store' } },
  );
}
