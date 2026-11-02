import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { compare } from 'bcryptjs';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

async function hashPassword(...args: string[]): Promise<string> {
  const { stdout } = await run('pnpm', ['exec', 'tsx', 'scripts/hash-password.ts', ...args]);
  return stdout;
}

interface GeneratedAccount {
  id: string;
  role: string;
  passwordHash: string;
  demoPassword: string;
}

describe('scripts/hash-password', () => {
  it('prints a bcrypt hash of the given password', async () => {
    const output = (await hashPassword('some-password')).trim();

    expect(output).toMatch(/^\$2[aby]\$10\$/);
    await expect(compare('some-password', output)).resolves.toBe(true);
  }, 30_000);

  it('generates four accounts whose hashes match their 12-char passwords', async () => {
    const lines = (await hashPassword()).split('\n').filter((line) => line.startsWith('DEMO_'));
    const [plain, escaped] = lines.map((line) => line.slice('DEMO_ACCOUNTS_JSON='.length));
    if (!plain || !escaped) throw new Error('expected a Vercel value and a .env.local value');

    const accounts = JSON.parse(plain) as GeneratedAccount[];
    expect(accounts.map(({ id, role }) => [id, role])).toEqual([
      ['sales', 'sales'],
      ['hr', 'hr'],
      ['ops', 'ops'],
      ['admin', 'admin'],
    ]);
    for (const { passwordHash, demoPassword } of accounts) {
      expect(demoPassword).toHaveLength(12);
      await expect(compare(demoPassword, passwordHash)).resolves.toBe(true);
    }

    expect(escaped).toBe(plain.replaceAll('$', '\\$'));
  }, 30_000);
});
