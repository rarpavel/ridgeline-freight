import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, dropDatabase, withClient } from './helpers/database';

vi.mock('server-only', () => ({}));

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/server/logger', () => ({ logger }));

const DB_NAME = `ridgeline_health_${process.pid}`;
const DB_PASSWORD = 'health-test-password';
const SHA = 'a'.repeat(40);

const FIELDS = ['db', 'embeddingModel', 'gitSha', 'promptVersion', 'status'];

async function loadHealth(databaseUrl: string) {
  vi.stubEnv('DATABASE_URL', databaseUrl);
  vi.resetModules();
  const { GET } = await import('@/app/api/health/route');
  const { pool } = await import('@/server/db/client');
  return { GET, pool };
}

describe('GET /api/health', () => {
  let url: string;

  beforeAll(async () => {
    await dropDatabase(DB_NAME);
    url = await createDatabase(DB_NAME);
  });

  afterAll(async () => {
    await dropDatabase(DB_NAME);
  });

  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-chars');
    vi.stubEnv(
      'DEMO_ACCOUNTS_JSON',
      JSON.stringify([{ id: 'sales', role: 'sales', passwordHash: `$2b$10$${'a'.repeat(53)}` }]),
    );
    vi.stubEnv('EMBEDDING_MODEL', 'test-embedding-model');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('returns 200 with the five fields and no-store when the database is up', async () => {
    const { GET, pool } = await loadHealth(url);
    try {
      const response = await GET();

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        status: 'ok',
        db: 'ok',
        embeddingModel: 'test-embedding-model',
        promptVersion: 'n/a',
        gitSha: SHA,
      });
    } finally {
      await pool.end();
    }
  });

  it('falls back to git rev-parse when VERCEL_GIT_COMMIT_SHA is not set', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', undefined);
    const { GET, pool } = await loadHealth(url);
    try {
      const body = (await (await GET()).json()) as { gitSha: string };

      expect(body.gitSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await pool.end();
    }
  });

  it('returns 503 without error details when the database refuses connections', async () => {
    // Port 1 has no listener, which stands in for a stopped database.
    const { GET, pool } = await loadHealth(
      `postgres://postgres:${DB_PASSWORD}@127.0.0.1:1/ridgeline`,
    );
    try {
      const response = await GET();
      const text = await response.text();

      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(body).toMatchObject({ status: 'error', db: 'error', gitSha: SHA });
      expect(Object.keys(body).sort()).toEqual(FIELDS);
      expect(text).not.toContain('ECONNREFUSED');
      expect(text).not.toContain('127.0.0.1');
      expect(text).not.toContain(DB_PASSWORD);

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), route: '/api/health' }),
        'health.db_error',
      );
    } finally {
      await pool.end();
    }
  });

  describe('when the database accepts connections and never answers', () => {
    let server: Server;
    const sockets = new Set<Socket>();

    beforeAll(async () => {
      server = createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    });

    afterAll(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });

    it('returns 503 within 9 seconds', async () => {
      const { port } = server.address() as AddressInfo;
      const { GET } = await loadHealth(`postgres://postgres:x@127.0.0.1:${port}/ridgeline`);

      const startedAt = Date.now();
      const response = await GET();
      const elapsedMs = Date.now() - startedAt;

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: 'error', db: 'error' });
      expect(elapsedMs).toBeGreaterThanOrEqual(7_900);
      expect(elapsedMs).toBeLessThanOrEqual(9_000);
    });
  });

  it('survives the server dropping an idle connection, then recovers', async () => {
    const { GET, pool } = await loadHealth(url);
    try {
      expect((await GET()).status).toBe(200);
      expect(pool.idleCount).toBeGreaterThan(0);

      // Without a pool "error" listener this is an uncaught exception, which kills the process.
      await withClient(url, (client) =>
        client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [DB_NAME],
        ),
      );
      await vi.waitFor(() => expect(pool.idleCount).toBe(0));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'db.pool_error',
      );
      expect((await GET()).status).toBe(200);
    } finally {
      await pool.end();
    }
  });
});
