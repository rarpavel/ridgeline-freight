import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { hashSync } from 'bcryptjs';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, dropDatabase, withClient } from './helpers/database';

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: () => {
      throw new Error('requireSession must not write cookies');
    },
  }),
}));

const run = promisify(execFile);

const DB_NAME = `ridgeline_auth_${process.pid}`;
const ORIGIN = 'https://ridgeline.test';
const PASSWORDS = { sales: 'sales-password', admin: 'admin-password' };
// Cost 4 is the bcrypt minimum; these hashes exist only for this test file.
const ACCOUNTS = [
  { id: 'sales', role: 'sales', passwordHash: hashSync(PASSWORDS.sales, 4) },
  { id: 'admin', role: 'admin', passwordHash: hashSync(PASSWORDS.admin, 4) },
];

const closeAppPools: (() => Promise<unknown>)[] = [];

async function loadAuth() {
  vi.resetModules();
  const [login, logout, proxyModule, requireModule, client] = await Promise.all([
    import('@/app/api/auth/login/route'),
    import('@/app/api/auth/logout/route'),
    import('@/proxy'),
    import('@/server/auth/require'),
    import('@/server/db/client'),
  ]);
  closeAppPools.push(() => client.pool.end());
  return { login: login.POST, logout: logout.POST, proxy: proxyModule.proxy, ...requireModule };
}

function loginRequest(body: unknown) {
  return new Request(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function pageRequest(path: string, cookie?: string) {
  return new NextRequest(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
}

/** The `name=value` pair a browser would send back, taken from a Set-Cookie header. */
function cookiePair(setCookie: string): string {
  const [pair] = setCookie.split(';');
  if (!pair) throw new Error('empty Set-Cookie header');
  return pair;
}

async function signIn(auth: Awaited<ReturnType<typeof loadAuth>>, account: 'sales' | 'admin') {
  const response = await auth.login(loginRequest({ account, password: PASSWORDS[account] }));
  expect(response.status).toBe(200);
  return cookiePair(response.headers.get('set-cookie') ?? '');
}

function isPassedThrough(response: Response): boolean {
  return response.headers.get('x-middleware-next') === '1';
}

describe('auth', () => {
  let url: string;

  beforeAll(async () => {
    await dropDatabase(DB_NAME);
    url = await createDatabase(DB_NAME);
    await run('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_URL_DIRECT: url } });
  });

  afterAll(async () => {
    await dropDatabase(DB_NAME);
  });

  beforeEach(async () => {
    await withClient(url, (client) => client.query('TRUNCATE rate_limits'));
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-chars');
    vi.stubEnv('DEMO_ACCOUNTS_JSON', JSON.stringify(ACCOUNTS));
    cookieJar.clear();
  });

  afterEach(async () => {
    await Promise.all(closeAppPools.splice(0).map((close) => close()));
    vi.unstubAllEnvs();
  });

  describe('POST /api/auth/login', () => {
    it('signs in with the right password: cookie attributes and requireSession', async () => {
      const auth = await loadAuth();

      const response = await auth.login(
        loginRequest({ account: 'sales', password: PASSWORDS.sales }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ account: 'sales', role: 'sales' });

      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toMatch(/;\s*HttpOnly/i);
      expect(setCookie).toMatch(/;\s*Secure/i);
      expect(setCookie).toMatch(/;\s*SameSite=Lax/i);
      // iron-session expires the cookie 60 s before the 12 h seal.
      expect(setCookie).toMatch(/;\s*Max-Age=43140/i);

      const [name, ...value] = cookiePair(setCookie).split('=');
      cookieJar.set(name ?? '', value.join('='));
      await expect(auth.requireSession()).resolves.toEqual({ account: 'sales', role: 'sales' });
    });

    it('answers 401 with the same body for a wrong password and an unknown account', async () => {
      const auth = await loadAuth();

      const wrongPassword = await auth.login(
        loginRequest({ account: 'sales', password: 'not-the-password' }),
      );
      const unknownAccount = await auth.login(
        loginRequest({ account: 'nobody', password: PASSWORDS.sales }),
      );

      expect(wrongPassword.status).toBe(401);
      expect(unknownAccount.status).toBe(401);
      expect(wrongPassword.headers.get('set-cookie')).toBeNull();
      expect(unknownAccount.headers.get('set-cookie')).toBeNull();

      const body = (await wrongPassword.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('unauthorized');
      expect(body.error.message).not.toMatch(/password is|account is|unknown|not found/i);
      expect(await unknownAccount.json()).toEqual(body);
    });

    it('answers 429 to the 6th attempt after 5 failures from one IP, even with the right password', async () => {
      const auth = await loadAuth();
      const fromIp = (ip: string, password: string) =>
        new Request(`${ORIGIN}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
          body: JSON.stringify({ account: 'sales', password }),
        });

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const failed = await auth.login(fromIp('203.0.113.7', 'not-the-password'));
        expect(failed.status).toBe(401);
      }

      const blocked = await auth.login(fromIp('203.0.113.7', PASSWORDS.sales));
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('set-cookie')).toBeNull();
      expect(await blocked.json()).toMatchObject({ error: { code: 'rate_limited' } });

      const otherIp = await auth.login(fromIp('203.0.113.8', PASSWORDS.sales));
      expect(otherIp.status).toBe(200);
    });

    it('counts only failures: successful logins do not use up the attempts', async () => {
      const auth = await loadAuth();

      for (let attempt = 1; attempt <= 6; attempt += 1) {
        await signIn(auth, 'sales');
      }
      const rows = await withClient(url, (client) =>
        client.query<{ count: number }>('SELECT count FROM rate_limits'),
      );
      expect(rows.rows.map(({ count }) => count)).toEqual([0]);
    });

    it('does not count a malformed login body', async () => {
      const auth = await loadAuth();

      expect((await auth.login(loginRequest('{not json'))).status).toBe(400);

      const rows = await withClient(url, (client) => client.query('SELECT 1 FROM rate_limits'));
      expect(rows.rowCount).toBe(0);
    });

    it('does not accept another account password', async () => {
      const auth = await loadAuth();

      const response = await auth.login(
        loginRequest({ account: 'admin', password: PASSWORDS.sales }),
      );

      expect(response.status).toBe(401);
    });

    it.each([
      ['malformed JSON', '{not json'],
      ['a missing password', { account: 'sales' }],
      ['a non-string account', { account: 1, password: 'x' }],
      ['an oversized password', { account: 'sales', password: 'x'.repeat(1_000) }],
    ])('answers 400 for %s', async (_label, body) => {
      const auth = await loadAuth();

      const response = await auth.login(loginRequest(body));

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'validation',
      );
    });
  });

  describe('proxy', () => {
    it.each(['/chat', '/documents/abc', '/admin/eval'])(
      'redirects %s to the login page when there is no cookie',
      async (path) => {
        const auth = await loadAuth();

        const response = await auth.proxy(pageRequest(path));

        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe(`${ORIGIN}/login?next=${path}`);
      },
    );

    it('keeps the query string in next, encoded', async () => {
      const auth = await loadAuth();

      const response = await auth.proxy(pageRequest('/chat?q=a&b=c'));

      expect(response.headers.get('location')).toBe(`${ORIGIN}/login?next=/chat%3Fq%3Da%26b%3Dc`);
    });

    it.each(['/api/chat', '/api/documents/abc', '/api/traces/abc'])(
      'answers 401 JSON instead of a redirect for %s',
      async (path) => {
        const auth = await loadAuth();

        const response = await auth.proxy(pageRequest(path));

        expect(response.status).toBe(401);
        expect(response.headers.get('location')).toBeNull();
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          'unauthorized',
        );
      },
    );

    it('treats a tampered cookie as no session', async () => {
      const auth = await loadAuth();
      const cookie = await signIn(auth, 'sales');
      // Segment 4 of the seal is the ciphertext. The trailing ~2 sits outside the HMAC and is ignored.
      const segments = cookie.split('*');
      const ciphertext = segments[4] ?? '';
      const middle = Math.floor(ciphertext.length / 2);
      const flipped = ciphertext[middle] === 'A' ? 'B' : 'A';
      segments[4] = `${ciphertext.slice(0, middle)}${flipped}${ciphertext.slice(middle + 1)}`;

      const response = await auth.proxy(pageRequest('/chat', segments.join('*')));

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(`${ORIGIN}/login?next=/chat`);
    });

    it('lets a signed-in session through to /chat', async () => {
      const auth = await loadAuth();
      const cookie = await signIn(auth, 'sales');

      expect(isPassedThrough(await auth.proxy(pageRequest('/chat', cookie)))).toBe(true);
    });

    it('answers 403 for a sales session on /admin/eval', async () => {
      const auth = await loadAuth();
      const cookie = await signIn(auth, 'sales');

      const response = await auth.proxy(pageRequest('/admin/eval', cookie));

      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('forbidden');
    });

    it('lets an admin session through to /admin/eval', async () => {
      const auth = await loadAuth();
      const cookie = await signIn(auth, 'admin');

      expect(isPassedThrough(await auth.proxy(pageRequest('/admin/eval', cookie)))).toBe(true);
    });

    it('does not treat a path that only starts with "admin" as admin-only', async () => {
      const auth = await loadAuth();
      const cookie = await signIn(auth, 'sales');

      expect(isPassedThrough(await auth.proxy(pageRequest('/administer', cookie)))).toBe(true);
    });
  });

  describe('requireSession and requireRole', () => {
    function useCookie(pair: string) {
      const [name, ...value] = pair.split('=');
      cookieJar.set(name ?? '', value.join('='));
    }

    it('requireSession throws unauthorized without a cookie', async () => {
      const auth = await loadAuth();

      await expect(auth.requireSession()).rejects.toMatchObject({
        code: 'unauthorized',
        status: 401,
      });
    });

    it('requireRole throws forbidden for the wrong role', async () => {
      const auth = await loadAuth();
      useCookie(await signIn(auth, 'sales'));

      await expect(auth.requireRole('admin')).rejects.toMatchObject({
        code: 'forbidden',
        status: 403,
      });
    });

    it('requireRole returns the session for the right role', async () => {
      const auth = await loadAuth();
      useCookie(await signIn(auth, 'admin'));

      await expect(auth.requireRole('admin')).resolves.toEqual({
        account: 'admin',
        role: 'admin',
      });
    });

    it('requireRole throws unauthorized without a cookie', async () => {
      const auth = await loadAuth();

      await expect(auth.requireRole('admin')).rejects.toMatchObject({ code: 'unauthorized' });
    });
  });

  describe('cross-site requests', () => {
    const CROSS_SITE = { origin: 'https://evil.test' };

    it('refuses a cross-site login and sets no cookie', async () => {
      const auth = await loadAuth();

      const response = await auth.login(
        new Request(`${ORIGIN}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain', ...CROSS_SITE },
          body: JSON.stringify({ account: 'sales', password: PASSWORDS.sales }),
        }),
      );

      expect(response.status).toBe(403);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('refuses a cross-site logout and leaves the cookie alone', async () => {
      const auth = await loadAuth();

      const response = await auth.logout(
        new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers: CROSS_SITE }),
      );

      expect(response.status).toBe(403);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('accepts the same origin, including behind a proxy that sets x-forwarded-host', async () => {
      const auth = await loadAuth();
      const body = JSON.stringify({ account: 'sales', password: PASSWORDS.sales });

      const direct = await auth.login(
        new Request(`${ORIGIN}/api/auth/login`, {
          method: 'POST',
          headers: { origin: ORIGIN },
          body,
        }),
      );
      const forwarded = await auth.login(
        new Request('http://internal.test/api/auth/login', {
          method: 'POST',
          headers: { origin: ORIGIN, 'x-forwarded-host': 'ridgeline.test' },
          body,
        }),
      );

      expect(direct.status).toBe(200);
      expect(forwarded.status).toBe(200);
    });

    it('refuses a malformed Origin', async () => {
      const auth = await loadAuth();

      const response = await auth.logout(
        new Request(`${ORIGIN}/api/auth/logout`, {
          method: 'POST',
          headers: { origin: 'null' },
        }),
      );

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears the cookie, after which /chat redirects to the login page again', async () => {
      const auth = await loadAuth();
      const cookie = await signIn(auth, 'sales');
      expect(isPassedThrough(await auth.proxy(pageRequest('/chat', cookie)))).toBe(true);

      const response = await auth.logout(
        new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers: { cookie } }),
      );

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/login');
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toMatch(/;\s*Max-Age=0/i);
      expect(setCookie).toMatch(/;\s*Path=\//i);

      // A browser drops an expired cookie, so the next request has only what Set-Cookie left.
      const after = await auth.proxy(pageRequest('/chat', cookiePair(setCookie)));
      expect(after.status).toBe(307);
      expect(after.headers.get('location')).toBe(`${ORIGIN}/login?next=/chat`);
    });
  });
});
