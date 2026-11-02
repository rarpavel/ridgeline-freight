import 'server-only';

import { compare } from 'bcryptjs';

import { env } from '@/env';

import type { Role } from './session';

export interface VerifiedAccount {
  id: string;
  role: Role;
}

/** Id, role and password for the login page. Never includes the hash. */
export function listDemoAccounts() {
  return env.DEMO_ACCOUNTS_JSON.map(({ id, role, demoPassword }) => ({ id, role, demoPassword }));
}

export async function verifyCredentials(
  account: string,
  password: string,
): Promise<VerifiedAccount | null> {
  const match = env.DEMO_ACCOUNTS_JSON.find(({ id }) => id === account);
  // An unknown account still pays for a compare, so timing does not reveal which ids exist.
  const hash = (match ?? env.DEMO_ACCOUNTS_JSON[0])?.passwordHash ?? '';
  const isValid = await compare(password, hash);
  return match && isValid ? { id: match.id, role: match.role } : null;
}
