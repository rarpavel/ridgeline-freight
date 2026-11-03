import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { sealData } from 'iron-session';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Role } from '@/server/auth/session';
import { requestTraces, type TraceRetrieval } from '@/server/db/schema/request-traces';

import { createDatabase, dropDatabase } from './helpers/database';

vi.mock('server-only', () => ({}));

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

const DB_NAME = `ridgeline_traces_route_${process.pid}`;
const SECRET = 'test-session-secret-at-least-32-chars';
const HASH = `$2b$10$${'a'.repeat(53)}`;
const QUESTION = 'How does PTO accrue in the first year?';
const GENERATED_TEXT = 'An unchecked draft answer the model wrote without citations.';

const RETRIEVAL: TraceRetrieval = {
  candidates: [
    {
      chunkId: randomUUID(),
      documentId: randomUUID(),
      slug: 'handbook-pto',
      sectionRef: '2.1',
      vectorRank: 1,
      vectorSim: 0.6123,
      ftsRank: 1,
      ftsScore: 0.1,
      rrf: 0.0328,
      inPrompt: true,
      cited: true,
    },
  ],
  bestSim: 0.6123,
  simFloor: 0.3,
  ftsMatches: 1,
  vectorUnavailable: false,
};

const GATE_RETRIEVAL: TraceRetrieval = {
  candidates: [
    {
      chunkId: randomUUID(),
      documentId: randomUUID(),
      slug: 'sop-dock',
      sectionRef: null,
      vectorRank: 1,
      vectorSim: 0.12,
      ftsRank: null,
      ftsScore: null,
      rrf: 0.0164,
      inPrompt: false,
      cited: false,
    },
  ],
  bestSim: 0.12,
  simFloor: 0.3,
  ftsMatches: 0,
  vectorUnavailable: false,
};

describe('GET /api/traces/:id', () => {
  let GET: typeof import('@/app/api/traces/[id]/route').GET;
  let appDb: typeof import('@/server/db/client').db;
  let closeAppPool: () => Promise<unknown>;

  async function signInAs(account: string, role: Role) {
    cookieJar.set(
      'ridgeline_session',
      await sealData({ account, role, issuedAt: Date.now() }, { password: SECRET }),
    );
  }

  function getTrace(id: string) {
    return GET(new Request(`https://ridgeline.test/api/traces/${id}`), {
      params: Promise.resolve({ id }),
    });
  }

  async function insertTrace(account: string, role: Role) {
    const id = randomUUID();
    await appDb.insert(requestTraces).values({
      id,
      source: 'chat',
      account,
      role,
      question: QUESTION,
      retrieval: RETRIEVAL,
      gate: 'answer',
      promptVersion: 'rag-system@v1#abcd1234',
      model: 'gpt-5-mini',
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.000123,
      ttftMs: 800,
      latencyMs: 2100,
      refused: true,
      refusalReason: 'no_valid_citations',
      generatedText: GENERATED_TEXT,
    });
    return id;
  }

  beforeAll(async () => {
    await dropDatabase(DB_NAME);
    const url = await createDatabase(DB_NAME);
    await run('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_URL_DIRECT: url } });

    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('SESSION_SECRET', SECRET);
    vi.stubEnv(
      'DEMO_ACCOUNTS_JSON',
      JSON.stringify([{ id: 'sales', role: 'sales', passwordHash: HASH }]),
    );

    ({ GET } = await import('@/app/api/traces/[id]/route'));
    const client = await import('@/server/db/client');
    appDb = client.db;
    closeAppPool = () => client.pool.end();
  });

  afterAll(async () => {
    await closeAppPool();
    vi.unstubAllEnvs();
    await dropDatabase(DB_NAME);
  });

  beforeEach(async () => {
    cookieJar.clear();
    await appDb.delete(requestTraces);
  });

  it('answers 401 without a session', async () => {
    const id = await insertTrace('sales', 'sales');

    const response = await getTrace(id);

    expect(response.status).toBe(401);
  });

  it('returns the own trace, never cached', async () => {
    const id = await insertTrace('sales', 'sales');
    await signInAs('sales', 'sales');

    const response = await getTrace(id);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      id,
      gate: 'answer',
      retrieval: RETRIEVAL,
      promptVersion: 'rag-system@v1#abcd1234',
      model: 'gpt-5-mini',
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.000123,
      ttftMs: 800,
      latencyMs: 2100,
      refused: true,
      refusalReason: 'no_valid_citations',
      citationsValid: 0,
      citationsDropped: 0,
      error: null,
    });
  });

  it('leaves out the original answer, the question and the account', async () => {
    const id = await insertTrace('sales', 'sales');
    await signInAs('sales', 'sales');

    const body = await (await getTrace(id)).text();

    expect(body).not.toContain(GENERATED_TEXT);
    expect(body).not.toContain(QUESTION);
    expect(JSON.parse(body)).not.toHaveProperty('account');
  });

  it("answers another account's trace exactly like a missing one", async () => {
    const id = await insertTrace('hr', 'hr');
    await signInAs('sales', 'sales');

    const foreign = await getTrace(id);
    const missing = await getTrace(randomUUID());

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
  });

  it('lets admin read any trace', async () => {
    const id = await insertTrace('hr', 'hr');
    await signInAs('admin', 'admin');

    const response = await getTrace(id);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id });
  });

  it('answers 404 to an id that is not a uuid', async () => {
    await signInAs('sales', 'sales');

    const response = await getTrace('not-a-uuid');

    expect(response.status).toBe(404);
  });

  it('returns what the panel shows for a gate refusal', async () => {
    const id = randomUUID();
    await appDb.insert(requestTraces).values({
      id,
      source: 'chat',
      account: 'sales',
      role: 'sales',
      question: QUESTION,
      retrieval: GATE_RETRIEVAL,
      gate: 'refuse_gate',
      refused: true,
      refusalReason: 'gate',
    });
    await signInAs('sales', 'sales');

    const response = await getTrace(id);

    expect(await response.json()).toMatchObject({
      gate: 'refuse_gate',
      refusalReason: 'gate',
      model: null,
      retrieval: { bestSim: 0.12, simFloor: 0.3, ftsMatches: 0 },
    });
  });
});
