import 'server-only';

import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';

import { AppError } from '@/lib/errors';

import { sessionOptions, type Role, type SessionData } from './session';

export interface SessionUser {
  account: string;
  role: Role;
}

export async function requireSession(): Promise<SessionUser> {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.account || !session.role) {
    throw new AppError('unauthorized', 'Sign in to continue.');
  }
  return { account: session.account, role: session.role };
}

export async function requireRole(role: Role): Promise<SessionUser> {
  const user = await requireSession();
  if (user.role !== role) {
    throw new AppError('forbidden', 'You do not have access to this page.');
  }
  return user;
}
