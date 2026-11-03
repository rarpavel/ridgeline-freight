import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// next.config.ts headers() only apply inside the Next.js server, so handlers called directly would
// not show them. This starts a real server, which cannot run next to `pnpm dev` in this directory.
const START_TIMEOUT_MS = 90_000;
const OUTPUT_TAIL_CHARS = 2_000;

// The login page and the proxy need a valid env but no database or provider. NODE_ENV=test makes
// Next.js skip .env.local, so real keys stay out and $ in the hash below is not expanded.
const SERVER_ENV = {
  DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:1/ridgeline',
  OPENAI_API_KEY: 'test-openai-key',
  SESSION_SECRET: 'test-session-secret-at-least-32-characters',
  DEMO_ACCOUNTS_JSON: JSON.stringify([
    { id: 'sales', role: 'sales', passwordHash: `$2b$10$${'a'.repeat(53)}` },
  ]),
  NODE_ENV: 'test',
  NEXT_TELEMETRY_DISABLED: '1',
} as const;

const EXPECTED_HEADERS = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe('security headers', () => {
  let server: ChildProcess;
  let baseUrl: string;
  // next dev rewrites tsconfig.json on start, and a test run must not leave the tree dirty.
  const tsconfig = readFileSync('tsconfig.json', 'utf8');

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;

    let output = '';
    let exited = false;
    // Its own process group, because next dev starts a child that has to stop with it.
    server = spawn('node_modules/.bin/next', ['dev', '--port', String(port)], {
      env: { ...process.env, ...SERVER_ENV },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-OUTPUT_TAIL_CHARS);
    };
    server.stdout?.on('data', collect);
    server.stderr?.on('data', collect);
    server.once('exit', () => {
      exited = true;
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline && !exited) {
      try {
        await fetch(`${baseUrl}/login`, { redirect: 'manual' });
        return;
      } catch {
        await sleep(250);
      }
    }
    throw new Error(`next dev did not start:\n${output}`);
  }, START_TIMEOUT_MS + 10_000);

  afterAll(() => {
    if (server.pid !== undefined && server.exitCode === null) {
      process.kill(-server.pid, 'SIGTERM');
    }
    writeFileSync('tsconfig.json', tsconfig);
  });

  it('are on the login page', async () => {
    const response = await fetch(`${baseUrl}/login`, { redirect: 'manual' });

    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
      expect(response.headers.get(name), name).toBe(value);
    }
  });

  it('are on a redirect from the proxy', async () => {
    const response = await fetch(`${baseUrl}/chat`, { redirect: 'manual' });

    expect(response.status).toBe(307);
    for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
      expect(response.headers.get(name), name).toBe(value);
    }
  });
});
