import { getIronSession, webCookies } from 'iron-session';
import { NextResponse, type NextRequest } from 'next/server';

import { AppError } from '@/lib/errors';
import { sessionOptions, type SessionData } from '@/server/auth/session';
import { errorResponse } from '@/server/http';

const ROUTE = 'proxy';

function loginRedirect(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  // Slashes stay readable (/login?next=/chat); everything that could break the query is encoded.
  const next = encodeURIComponent(`${pathname}${search}`).replaceAll('%2F', '/');
  return NextResponse.redirect(new URL(`/login?next=${next}`, request.url));
}

/**
 * Redirects only: this is a first line for navigation, not the authorization check. Every handler
 * repeats it with requireSession/requireRole, so a matcher change cannot open a route.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const session = await getIronSession<SessionData>(
    webCookies(request, new Headers()),
    sessionOptions,
  );

  if (!session.account) {
    return pathname.startsWith('/api/')
      ? errorResponse(new AppError('unauthorized', 'Sign in to continue.'), ROUTE)
      : loginRedirect(request);
  }

  if ((pathname === '/admin' || pathname.startsWith('/admin/')) && session.role !== 'admin') {
    return errorResponse(new AppError('forbidden', 'You do not have access to this page.'), ROUTE);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/chat/:path*',
    '/documents/:path*',
    '/admin/:path*',
    '/api/chat/:path*',
    '/api/documents/:path*',
    '/api/traces/:path*',
  ],
};
