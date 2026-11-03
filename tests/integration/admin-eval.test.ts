import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { sealData } from 'iron-session';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Role } from '@/server/auth/session';
import { evalQuestions, evalResults, evalRuns } from '@/server/db/schema/eval';
import type { Category, Metrics, ResultScores, RunMetrics } from '@/server/eval/metrics';

import { QUESTION_CATEGORIES } from '../../data-gen/schemas/questions';
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
      throw new Error('requireRole must not write cookies');
    },
  }),
}));

const run = promisify(execFile);

const DB_NAME = `ridgeline_admin_eval_${process.pid}`;
const SECRET = 'test-session-secret-at-least-32-chars';
const HASH = `$2b$10$${'a'.repeat(53)}`;
const COOKIE = 'ridgeline_session';
const RUN_A = 'label-run-a';
const RUN_B = 'label-run-b';
const OPEN_RUN = 'label-open-run';
const RATIONALE = 'The rationale of the judge about this answer.';
const HOSTILE_ANSWER = '<img src=x onerror=alert(1)> Harbor Point pays 1.5% per week [1].';

const RETRIEVAL_CONFIG = {
  k: 20,
  vectorTopK: 20,
  ftsTopK: 20,
  finalK: 8,
  perDocCap: 3,
  simFloor: 0.45,
};

function metrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    questions: 5,
    retrievalHitRate: 0.875,
    'retrievalHitRate@20': 1,
    leakCount: 0,
    refusalAccuracy: 0.75,
    falseRefusalRate: 0,
    citationValidity: 1,
    ttftP50: 2345,
    ttftP95: 4000,
    latencyP50: 5000,
    latencyP95: 7000,
    costPerQuestion: 0.000123,
    truncatedAnswers: 0,
    outputTokensMax: 300,
    correctness: 0.625,
    faithfulness: 0.5,
    needsReview: 0,
    judgeErrors: 0,
    ...overrides,
  };
}

const SCORES: ResultScores = {
  retrievalHit: true,
  retrievalHit20: true,
  refusalCorrect: null,
  leak: null,
  citationsValid: 1,
  citationsDropped: 0,
  truncated: false,
  outputTokens: 300,
  correctness: 1,
  faithfulness: 0.5,
};

describe('/admin/eval', () => {
  let ListPage: typeof import('@/app/admin/eval/page').default;
  let DetailPage: typeof import('@/app/admin/eval/[runId]/page').default;
  let proxy: typeof import('@/proxy').proxy;
  let appDb: typeof import('@/server/db/client').db;
  let closeAppPool: () => Promise<unknown>;
  let runAId: string;
  let runBId: string;
  let openRunId: string;
  const traceId = randomUUID();

  async function sessionCookie(account: string, role: Role): Promise<string> {
    return sealData({ account, role, issuedAt: Date.now() }, { password: SECRET });
  }

  async function signInAs(account: string, role: Role) {
    cookieJar.set(COOKIE, await sessionCookie(account, role));
  }

  async function listHtml(): Promise<string> {
    return renderToStaticMarkup(await ListPage());
  }

  function detail(runId: string, category?: string) {
    return DetailPage({
      params: Promise.resolve({ runId }),
      searchParams: Promise.resolve(category === undefined ? {} : { category }),
    });
  }

  async function detailHtml(runId: string, category?: string): Promise<string> {
    return renderToStaticMarkup(await detail(runId, category));
  }

  function insertRun(values: { label: string; startedAt: Date; metrics: RunMetrics | null }) {
    return appDb
      .insert(evalRuns)
      .values({
        ...values,
        split: 'dev',
        model: 'gpt-5-mini',
        embeddingModel: 'text-embedding-3-small',
        judgeModel: 'claude-haiku-5-5',
        promptVersion: 'rag-system@v3#5dc28de8',
        retrievalConfig: RETRIEVAL_CONFIG,
        gitSha: 'abc1234',
        datasetVersion: 'dataset-7',
        finishedAt: values.metrics ? values.startedAt : null,
      })
      .returning({ id: evalRuns.id });
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

    ({ default: ListPage } = await import('@/app/admin/eval/page'));
    ({ default: DetailPage } = await import('@/app/admin/eval/[runId]/page'));
    ({ proxy } = await import('@/proxy'));
    const client = await import('@/server/db/client');
    appDb = client.db;
    closeAppPool = () => client.pool.end();

    const byCategory = Object.fromEntries(
      QUESTION_CATEGORIES.map((category, i) => [category, metrics({ questions: i + 1 })]),
    ) as Record<Category, Metrics>;
    const [runA] = await insertRun({
      label: RUN_A,
      startedAt: new Date('2026-11-01T10:00:00Z'),
      metrics: { overall: metrics(), byCategory },
    });
    const [runB] = await insertRun({
      label: RUN_B,
      startedAt: new Date('2026-11-02T10:00:00Z'),
      metrics: {
        // Without the judge these are null; a run from before the judge has no such keys at all.
        overall: metrics({ correctness: null, faithfulness: undefined as unknown as null }),
        byCategory: {},
      },
    });
    const [open] = await insertRun({
      label: OPEN_RUN,
      startedAt: new Date('2026-11-03T10:00:00Z'),
      metrics: null,
    });
    runAId = runA?.id ?? '';
    runBId = runB?.id ?? '';
    openRunId = open?.id ?? '';

    const questions = await appDb
      .insert(evalQuestions)
      .values(
        QUESTION_CATEGORIES.map((category) => ({
          slug: `${category}-01`,
          category,
          split: 'dev',
          role: 'sales',
          question: `The question of ${category}?`,
          expectedAnswer: category === 'no_answer' ? null : `The reference of ${category}`,
          reviewed: true,
          datasetVersion: 'dataset-7',
        })),
      )
      .returning({ id: evalQuestions.id, category: evalQuestions.category });

    await appDb.insert(evalResults).values(
      questions.map(({ id, category }) => ({
        runId: runAId,
        questionId: id,
        answer: category === 'direct' ? HOSTILE_ANSWER : `The answer of ${category}`,
        refused: category === 'no_answer',
        retrieved: [],
        scores: category === 'comparison' ? { ...SCORES, judgeError: 'invalid reply' } : SCORES,
        judgeRationale: category === 'direct' ? RATIONALE : null,
        ttftMs: 1500,
        latencyMs: 2345,
        costUsd: 0.0001,
        traceId: category === 'direct' ? traceId : null,
      })),
    );
  });

  afterAll(async () => {
    await closeAppPool();
    vi.unstubAllEnvs();
    await dropDatabase(DB_NAME);
  });

  beforeEach(() => {
    cookieJar.clear();
  });

  describe('access', () => {
    it.each(['sales', 'hr', 'ops'] as const)('refuses a %s session on both pages', async (role) => {
      await signInAs(role, role);

      await expect(ListPage()).rejects.toMatchObject({ code: 'forbidden' });
      await expect(detail(runAId)).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('refuses a request without a session on both pages', async () => {
      await expect(ListPage()).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(detail(runAId)).rejects.toMatchObject({ code: 'unauthorized' });
    });

    it('answers 403 in the proxy for a sales session, with no run data', async () => {
      const cookie = await sessionCookie('sales', 'sales');
      const request = new NextRequest(`https://ridgeline.test/admin/eval/${runAId}`, {
        headers: { cookie: `${COOKIE}=${cookie}` },
      });

      const response = await proxy(request);
      const body = await response.text();

      expect(response.status).toBe(403);
      expect(body).not.toContain(RUN_A);
      expect(body).not.toContain(HOSTILE_ANSWER);
    });
  });

  describe('list', () => {
    it('shows every run, newest first, with its versions and headline metrics', async () => {
      await signInAs('admin', 'admin');

      const html = await listHtml();

      expect(html.indexOf(OPEN_RUN)).toBeLessThan(html.indexOf(RUN_B));
      expect(html.indexOf(RUN_B)).toBeLessThan(html.indexOf(RUN_A));
      expect(html).toContain('2026-11-01 10:00 UTC');
      expect(html).toContain('gpt-5-mini');
      expect(html).toContain('rag-system@v3#5dc28de8');
      expect(html).toContain('dataset-7');
      for (const value of ['0.875', '0.625', '0.500', '0.750', '2,345 ms', '$0.000123']) {
        expect(html).toContain(value);
      }
      expect(html).toContain(`href="/admin/eval/${runAId}"`);
      expect(html).toContain(`href="/admin/eval/${runBId}"`);
    });

    it('marks a run that has not finished', async () => {
      await signInAs('admin', 'admin');

      expect(await listHtml()).toContain('Not finished');
    });
  });

  describe('detail', () => {
    it('shows the metrics of every category', async () => {
      await signInAs('admin', 'admin');

      const html = await detailHtml(runAId);

      for (const category of QUESTION_CATEGORIES) {
        expect(html).toContain(`data-testid="metrics-${category}"`);
      }
      expect(html).toContain('data-testid="metrics-overall"');
    });

    it('shows every question row with its columns and a trace link', async () => {
      await signInAs('admin', 'admin');

      const html = await detailHtml(runAId);

      for (const category of QUESTION_CATEGORIES) {
        expect(html).toContain(`The question of ${category}?`);
      }
      expect(html).toContain('The reference of direct');
      expect(html).toContain('The answer of exception');
      expect(html).toContain('2,345 ms');
      expect(html).toContain(`href="/api/traces/${traceId}"`);
      expect(html.match(/data-testid="result-row"/g)).toHaveLength(QUESTION_CATEGORIES.length);
    });

    it('keeps the rationale behind an expandable element', async () => {
      await signInAs('admin', 'admin');

      expect(await detailHtml(runAId)).toMatch(/<details[^>]*>[^]*The rationale of the judge/);
    });

    it('flags a result the judge could not score', async () => {
      await signInAs('admin', 'admin');

      expect(await detailHtml(runAId)).toContain('Judge error');
    });

    it('renders a stored answer as text, never as markup', async () => {
      await signInAs('admin', 'admin');

      const html = await detailHtml(runAId);

      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('filters the rows by category and keeps the metrics of all of them', async () => {
      await signInAs('admin', 'admin');

      const html = await detailHtml(runAId, 'exception');

      expect(html.match(/data-testid="result-row"/g)).toHaveLength(1);
      expect(html).toContain('The question of exception?');
      expect(html).not.toContain('The question of direct?');
      expect(html).toContain('data-testid="metrics-direct"');
    });

    it('ignores an unknown category', async () => {
      await signInAs('admin', 'admin');

      const html = await detailHtml(runAId, 'nonsense');

      expect(html.match(/data-testid="result-row"/g)).toHaveLength(QUESTION_CATEGORIES.length);
    });

    it('shows a dash for metrics a run does not have', async () => {
      await signInAs('admin', 'admin');

      const metricsRow = (html: string, name: string) =>
        html.match(new RegExp(`<tr[^>]*data-testid="metrics-${name}"[^]*?</tr>`))?.[0] ?? '';

      // No key for this category at all, and null or absent for the judge's two metrics.
      const noJudge = await detailHtml(runBId);
      expect(metricsRow(noJudge, 'direct').match(/—/g)).toHaveLength(8);
      expect(metricsRow(noJudge, 'overall').match(/—/g)).toHaveLength(2);

      const open = await detailHtml(openRunId);
      expect(open).toContain('Not finished');
      expect(metricsRow(open, 'overall').match(/—/g)).toHaveLength(8);
    });

    it.each(['not-a-uuid', randomUUID()])('answers 404 to the unknown run %s', async (id) => {
      await signInAs('admin', 'admin');

      await expect(detail(id)).rejects.toMatchObject({
        digest: expect.stringContaining('404'),
      });
    });
  });
});
