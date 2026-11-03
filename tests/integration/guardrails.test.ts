import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sealData } from 'iron-session';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/lib/errors';

import { createDatabase, dropDatabase, withClient } from './helpers/database';

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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

const fakeOpenai = vi.hoisted(() => ({
  chat: { completions: { create: vi.fn() } },
  embeddings: { create: vi.fn() },
}));
vi.mock('@/server/llm/client', () => ({ openai: fakeOpenai }));

const run = promisify(execFile);

const DB_NAME = `ridgeline_guardrails_${process.pid}`;
const SECRET = 'test-session-secret-at-least-32-chars';
const HASH = `$2b$10$${'a'.repeat(53)}`;
const QUESTION = 'What is the late delivery penalty?';
// Above what the 20 answers of the rate limit test use.
const BUDGET = 10_000;
const NOW = new Date('2026-11-03T08:30:00.000Z');
const TODAY = '2026-11-03';
const NEXT_HOUR = new Date('2026-11-03T09:00:00.000Z');
const USAGE = { prompt_tokens: 120, completion_tokens: 8 };

const VECTOR = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));

async function* completion() {
  yield { choices: [{ delta: { content: 'It is $250.00 [1]' } }], usage: null };
  yield { choices: [], usage: USAGE };
}

function chatRequest(question: string, headers: Record<string, string> = {}) {
  return new Request('https://ridgeline.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ question }),
  });
}

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

async function rejectionOf(promise: Promise<unknown>) {
  const error: unknown = await promise.catch((err: unknown) => err);
  return error instanceof AppError ? error.code : error;
}

describe('guardrails', () => {
  let url: string;
  let POST: (request: Request) => Promise<Response>;
  let db: typeof import('@/server/db/client').db;
  let rateLimit: typeof import('@/server/guardrails/rateLimit');
  let budget: typeof import('@/server/guardrails/budget');
  let limits: typeof import('@/server/guardrails/limits');
  let answer: typeof import('@/server/rag/answer');
  let closeAppPool: () => Promise<unknown>;

  const query = <T extends object>(text: string, values: unknown[] = []) =>
    withClient(url, (client) => client.query<T & import('pg').QueryResultRow>(text, values));

  beforeAll(async () => {
    await dropDatabase(DB_NAME);
    url = await createDatabase(DB_NAME);
    await run('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_URL_DIRECT: url } });

    const { rows } = await query<{ id: string }>(
      `INSERT INTO documents (slug, title, doc_type, access_roles, source_path, checksum, chunker_version)
       VALUES ('msa', 'Harbor Point MSA', 'msa', '{sales,hr,admin}', 'data/corpus/msa.docx', 'c', 'test')
       RETURNING id`,
    );
    await query(
      `INSERT INTO chunks (document_id, ordinal, context_prefix, content, char_start, char_end,
                           token_count, embedding, embedding_model)
       VALUES ($1, 0, 'Harbor Point MSA', 'Late delivery penalty is $250.00.', 0, 10, 5, $2, 'fake')`,
      [rows[0]?.id, `[${VECTOR.join(',')}]`],
    );

    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('CHAT_MODEL', 'test-chat-model');
    vi.stubEnv('SESSION_SECRET', SECRET);
    vi.stubEnv('DAILY_TOKEN_BUDGET', String(BUDGET));
    vi.stubEnv('RATE_LIMIT_ACCOUNT_PER_HOUR', '20');
    vi.stubEnv('RATE_LIMIT_IP_PER_HOUR', '40');
    vi.stubEnv('MAX_QUESTION_CHARS', '500');
    vi.stubEnv(
      'DEMO_ACCOUNTS_JSON',
      JSON.stringify([{ id: 'sales', role: 'sales', passwordHash: HASH }]),
    );

    ({ POST } = await import('@/app/api/chat/route'));
    rateLimit = await import('@/server/guardrails/rateLimit');
    budget = await import('@/server/guardrails/budget');
    limits = await import('@/server/guardrails/limits');
    answer = await import('@/server/rag/answer');
    const client = await import('@/server/db/client');
    db = client.db;
    closeAppPool = () => client.pool.end();
  });

  afterAll(async () => {
    await closeAppPool();
    vi.unstubAllEnvs();
    await dropDatabase(DB_NAME);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Only Date: real timers keep the database driver working. A frozen clock also keeps a run that
    // crosses the hour from splitting the requests into two windows.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await query('TRUNCATE rate_limits, usage_daily, request_traces');
    fakeOpenai.chat.completions.create.mockImplementation(async () => completion());
    fakeOpenai.embeddings.create.mockResolvedValue({
      data: [{ index: 0, embedding: VECTOR }],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });
    cookieJar.set(
      'ridgeline_session',
      await sealData(
        { account: 'sales', role: 'sales', issuedAt: Date.now() },
        { password: SECRET },
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('POST /api/chat', () => {
    it('answers the 21st request of an hour with 429, without calling the model', async () => {
      for (let request = 1; request <= 20; request += 1) {
        const response = await POST(chatRequest(QUESTION));
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(fakeOpenai.chat.completions.create).toHaveBeenCalledTimes(20);

      const response = await POST(chatRequest(QUESTION));

      expect(response.status).toBe(429);
      expect((await errorOf(response)).code).toBe('rate_limited');
      expect(fakeOpenai.chat.completions.create).toHaveBeenCalledTimes(20);
      expect(fakeOpenai.embeddings.create).toHaveBeenCalledTimes(20);
    });

    it('answers 503 budget_exhausted without any model or embedding call', async () => {
      await query(
        'INSERT INTO usage_daily (day, input_tokens, output_tokens) VALUES ($1, $2, $3)',
        [TODAY, BUDGET - 1, 1],
      );

      const response = await POST(chatRequest(QUESTION));

      expect(response.status).toBe(503);
      expect(await errorOf(response)).toEqual({
        code: 'budget_exhausted',
        message: 'Demo budget for today is spent.',
      });
      expect(fakeOpenai.chat.completions.create).not.toHaveBeenCalled();
      expect(fakeOpenai.embeddings.create).not.toHaveBeenCalled();
    });

    it('answers while the budget is not reached yet', async () => {
      await query(
        'INSERT INTO usage_daily (day, input_tokens, output_tokens) VALUES ($1, $2, $3)',
        [TODAY, BUDGET - 1, 0],
      );

      const response = await POST(chatRequest(QUESTION));
      await response.text();

      expect(response.status).toBe(200);
    });

    it('answers 400 validation to 501 characters before touching the database or the model', async () => {
      const response = await POST(chatRequest('x'.repeat(501)));

      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('validation');
      expect(fakeOpenai.chat.completions.create).not.toHaveBeenCalled();
      const { rowCount } = await query('SELECT 1 FROM rate_limits');
      expect(rowCount).toBe(0);
    });

    it('adds the tokens and the cost of each answer to usage_daily', async () => {
      await (await POST(chatRequest(QUESTION))).text();
      await (await POST(chatRequest(QUESTION))).text();

      const { rows } = await query<{
        requests: number;
        input_tokens: string;
        output_tokens: string;
      }>('SELECT requests, input_tokens, output_tokens FROM usage_daily WHERE day = $1', [TODAY]);
      expect(rows).toEqual([{ requests: 2, input_tokens: '240', output_tokens: '16' }]);
    });

    it('stores a hash of the first forwarded address, never the address', async () => {
      const ip = '203.0.113.7';
      const response = await POST(chatRequest(QUESTION, { 'x-forwarded-for': `${ip}, 10.0.0.1` }));
      await response.text();

      const { rows } = await query<{ key: string }>('SELECT key FROM rate_limits ORDER BY key');
      expect(rows.map(({ key }) => key)).toEqual(['acct:sales', `ip:${limits.hashIp(ip)}`]);
      expect(limits.hashIp(ip)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('fails closed when the database cannot count: 503 db_error', async () => {
    await expect(
      limits.failClosed(() => Promise.reject(new Error('connection refused'))),
    ).rejects.toMatchObject({ code: 'db_error', status: 503 });
  });

  describe('rate limit windows', () => {
    const deps = (now: Date) => ({ db, clock: () => now });
    const sales = { account: 'sales', ip: '203.0.113.7' };

    it('allows the account again in the next window', async () => {
      for (let request = 1; request <= 20; request += 1) {
        await rateLimit.assertChatRateLimit(sales, deps(NOW));
      }
      expect(await rejectionOf(rateLimit.assertChatRateLimit(sales, deps(NOW)))).toBe(
        'rate_limited',
      );

      await expect(rateLimit.assertChatRateLimit(sales, deps(NEXT_HOUR))).resolves.toBeUndefined();
    });

    it('limits one IP across accounts at 40 an hour', async () => {
      for (let request = 1; request <= 40; request += 1) {
        const account = `account-${request % 3}`;
        await rateLimit.assertChatRateLimit({ account, ip: sales.ip }, deps(NOW));
      }

      expect(
        await rejectionOf(
          rateLimit.assertChatRateLimit({ account: 'fresh', ip: sales.ip }, deps(NOW)),
        ),
      ).toBe('rate_limited');
      await expect(
        rateLimit.assertChatRateLimit({ account: 'fresh', ip: '203.0.113.8' }, deps(NOW)),
      ).resolves.toBeUndefined();
    });

    it('does not spend the account quota once the IP is over its limit', async () => {
      await query('INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 40)', [
        `ip:${limits.hashIp(sales.ip)}`,
        new Date('2026-11-03T08:00:00.000Z'),
      ]);

      await rejectionOf(rateLimit.assertChatRateLimit(sales, deps(NOW)));

      const { rowCount } = await query("SELECT 1 FROM rate_limits WHERE key = 'acct:sales'");
      expect(rowCount).toBe(0);
    });

    it('allows failed logins again in the next window', async () => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await rateLimit.reserveLoginAttempt(sales.ip, deps(NOW));
      }
      expect(await rejectionOf(rateLimit.reserveLoginAttempt(sales.ip, deps(NOW)))).toBe(
        'rate_limited',
      );

      await expect(
        rateLimit.reserveLoginAttempt(sales.ip, deps(NEXT_HOUR)),
      ).resolves.toBeInstanceOf(Function);
    });
  });

  describe('daily budget', () => {
    it('opens again on the next UTC day', async () => {
      const today = { db, clock: () => NOW };
      await budget.recordDailyUsage(
        { inputTokens: BUDGET, outputTokens: 0, costUsd: 0.001 },
        today,
      );
      expect(await rejectionOf(budget.assertDailyBudget(today))).toBe('budget_exhausted');

      await expect(
        budget.assertDailyBudget({ db, clock: () => new Date('2026-11-04T00:00:00.000Z') }),
      ).resolves.toBeUndefined();
    });

    it('keeps costs far below a cent when it adds them up', async () => {
      const today = { db, clock: () => NOW };
      const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0.00003 };
      await budget.recordDailyUsage(usage, today);
      await budget.recordDailyUsage(usage, today);

      const { rows } = await query<{ cost_usd: string }>('SELECT cost_usd FROM usage_daily');
      expect(Number(rows[0]?.cost_usd)).toBeCloseTo(0.00006, 6);
    });

    it('is left alone by a caller without recordUsage, as the eval CLI is', async () => {
      const events = answer.answerQuestion(
        { question: QUESTION, user: { account: 'eval', role: 'sales' } },
        {
          db,
          embed: async () => ({ embedding: VECTOR, tokens: 5 }),
          llm: fakeOpenai.chat.completions.create,
          signal: new AbortController().signal,
          source: 'eval',
        },
      );
      for await (const event of events) void event;

      const { rowCount } = await query('SELECT 1 FROM usage_daily');
      expect(rowCount).toBe(0);
    });
  });
});
