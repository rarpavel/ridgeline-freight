import { getIronSession } from 'iron-session';

import { sessionOptions, type SessionData } from '@/server/auth/session';
import { assertSameOrigin, errorResponse } from '@/server/http';

const ROUTE = '/api/auth/logout';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    // 303 so a plain <form method="post"> ends on a GET of the login page.
    const response = new Response(null, { status: 303, headers: { Location: '/login' } });
    const session = await getIronSession<SessionData>(request, response, sessionOptions);
    session.destroy();
    return response;
  } catch (err) {
    return errorResponse(err, ROUTE);
  }
}
