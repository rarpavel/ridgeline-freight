import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const SECRET = 'test-session-secret-at-least-32-chars';
const HASH = `$2b$10$${'a'.repeat(53)}`;

const VALID_ENV = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/ridgeline',
  OPENAI_API_KEY: 'test-openai-key',
  SESSION_SECRET: SECRET,
  DEMO_ACCOUNTS_JSON: JSON.stringify([{ id: 'sales', role: 'sales', passwordHash: HASH }]),
};

async function importEnv() {
  vi.resetModules();
  return import('@/env');
}

describe('env', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(VALID_ENV)) {
      vi.stubEnv(name, value);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses a valid environment and applies defaults', async () => {
    const { env } = await importEnv();

    expect(env.CHAT_MODEL).toBe('gpt-5-mini');
    expect(env.SIM_FLOOR).toBe(0.45);
    expect(env.DEMO_ACCOUNTS_JSON).toEqual([{ id: 'sales', role: 'sales', passwordHash: HASH }]);
  });

  it('accepts an optional demoPassword', async () => {
    const account = { id: 'sales', role: 'sales', passwordHash: HASH, demoPassword: 'shown' };
    vi.stubEnv('DEMO_ACCOUNTS_JSON', JSON.stringify([account]));

    const { env } = await importEnv();

    expect(env.DEMO_ACCOUNTS_JSON).toEqual([account]);
  });

  it('stops the boot on a hash that an unescaped $ in .env.local has shortened', async () => {
    // What is left of a real hash after Next.js expands $2b, $10 and the salt prefix.
    const mangled = './Wq1VtZ8mYxKpLr3nGd5sHfTjBc7eNaU';
    vi.stubEnv(
      'DEMO_ACCOUNTS_JSON',
      JSON.stringify([{ id: 'sales', role: 'sales', passwordHash: mangled }]),
    );

    const error = await importEnv().catch((caught: unknown) => caught);

    expect(String(error)).toContain('DEMO_ACCOUNTS_JSON.0.passwordHash');
    expect(String(error)).toContain('\\$');
    expect(String(error)).not.toContain(mangled);
  });

  it.each(['DATABASE_URL', 'SESSION_SECRET'])('names a missing %s in the error', async (name) => {
    vi.stubEnv(name, undefined);

    await expect(importEnv()).rejects.toThrow(name);
  });

  it('treats an empty value as missing and lists every missing variable', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('DATABASE_URL', undefined);

    const error = await importEnv().catch((caught: unknown) => caught);

    expect(String(error)).toContain('OPENAI_API_KEY');
    expect(String(error)).toContain('DATABASE_URL');
  });

  it.each([
    ['not JSON', 'not-json'],
    ['not an array', '{"id":"sales"}'],
    ['an unknown role', '[{"id":"x","role":"root","passwordHash":"h"}]'],
    ['a missing hash', '[{"id":"sales","role":"sales"}]'],
  ])('rejects DEMO_ACCOUNTS_JSON with %s', async (_label, value) => {
    vi.stubEnv('DEMO_ACCOUNTS_JSON', value);

    await expect(importEnv()).rejects.toThrow('DEMO_ACCOUNTS_JSON');
  });

  it('does not echo rejected values in the error', async () => {
    vi.stubEnv('SESSION_SECRET', 'too-short-secret');
    vi.stubEnv('DEMO_ACCOUNTS_JSON', 'secret-looking-json');

    const error = await importEnv().catch((caught: unknown) => caught);

    expect(String(error)).toContain('SESSION_SECRET');
    expect(String(error)).not.toContain('too-short-secret');
    expect(String(error)).not.toContain('secret-looking-json');
  });

  it('lists exactly the schema variables in .env.example', async () => {
    const { envSchema } = await importEnv();
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    const listed = [...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((match) => match[1]);

    expect(listed.sort()).toEqual(Object.keys(envSchema.shape).sort());
  });
});
