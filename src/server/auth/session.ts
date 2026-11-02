import 'server-only';

import type { SessionOptions } from 'iron-session';

import { env } from '@/env';

export type Role = (typeof env.DEMO_ACCOUNTS_JSON)[number]['role'];

export interface SessionData {
  account: string;
  role: Role;
  issuedAt: number;
}

const SESSION_TTL_SECONDS = 12 * 60 * 60;

export const sessionOptions: SessionOptions = {
  cookieName: 'ridgeline_session',
  password: env.SESSION_SECRET,
  ttl: SESSION_TTL_SECONDS,
  cookieOptions: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
};
