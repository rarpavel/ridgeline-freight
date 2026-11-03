import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { chunks } from '@/server/db/schema/chunks';
import { documents } from '@/server/db/schema/documents';
import { evalQuestions, evalResults, evalRuns } from '@/server/db/schema/eval';
import { requestTraces } from '@/server/db/schema/request-traces';
import { METRIC_KEYS } from '@/server/eval/metrics';
import type { RunEvalDeps, RunEvalInput } from '@/server/eval/runner';
import type { StreamChat } from '@/server/rag/generate';

import { createDatabase, dropDatabase } from './helpers/database';

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const run = promisify(execFile);

const DB_NAME = `ridgeline_eval_runner_${process.pid}`;
const REPO = process.cwd();
const DIMENSIONS = 1536;
const DATASET = 'test-dataset';
const HASH = `$2b$10$${'a'.repeat(53)}`;
const CLI_ENV = {
  OPENAI_API_KEY: 'unused-before-the-run',
  SESSION_SECRET: 'test-session-secret-at-least-32-chars',
  DEMO_ACCOUNTS_JSON: JSON.stringify([{ id: 'sales', role: 'sales', passwordHash: HASH }]),
};

const VECTOR = Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
const LOW_SIM_VECTOR = Array.from({ length: DIMENSIONS }, (_, i) => {
  if (i === 0) return 0.12;
  return i === 1 ? Math.sqrt(1 - 0.12 ** 2) : 0;
});

function questionFixture(
  slug: string,
  split: 'dev' | 'test',
  overrides: Record<string, unknown> = {},
) {
  return {
    slug,
    category: 'direct',
    split,
    role: 'sales',
    question: `Which zebra quokka fact does question ${slug} ask about?`,
    expectedAnswer: 'A fact',
    expectedDocSlugs: ['msa-harbor'],
    sourceFactIds: [],
    distractorDocSlugs: [],
    notes: '',
    reviewed: true,
    datasetVersion: DATASET,
    ...overrides,
  };
}

const DEV_QUESTIONS = [
  questionFixture('direct-01', 'dev'),
  questionFixture('no_answer-01', 'dev', {
    category: 'no_answer',
    expectedAnswer: null,
    expectedDocSlugs: [],
  }),
  questionFixture('other_role-01', 'dev', {
    category: 'other_role',
    expectedAnswer: null,
    expectedDocSlugs: ['hr-handbook'],
  }),
];
const TEST_QUESTIONS = Array.from({ length: 12 }, (_, i) =>
  questionFixture(`direct-${String(i + 10)}`, 'test'),
);

function modelReplies(reply: (prompt: string) => string): StreamChat {
  return vi.fn(async (messages) => {
    const text = reply(JSON.stringify(messages));
    return (async function* () {
      yield { choices: [{ delta: { content: text } }], usage: null };
      yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } };
    })() as never;
  });
}

const answersOrRefuses = modelReplies((prompt) =>
  prompt.includes('direct-') ? 'The fact [1]' : 'NO_ANSWER: Not in the documents.',
);

describe('runEval', () => {
  let runEval: typeof import('@/server/eval/runner').runEval;
  let appDb: typeof import('@/server/db/client').db;
  let closeAppPool: () => Promise<unknown>;
  let url: string;
  let fixtureDir: string;
  let questionsPath: string;

  function evalDeps(overrides: Partial<RunEvalDeps> = {}): RunEvalDeps {
    return {
      db: appDb,
      embed: async () => ({ embedding: VECTOR, tokens: 9 }),
      llm: answersOrRefuses,
      signal: new AbortController().signal,
      gitSha: 'abc1234',
      datasetVersion: DATASET,
      questionsPath,
      ...overrides,
    };
  }

  const start = (input: RunEvalInput, overrides?: Partial<RunEvalDeps>) =>
    runEval(input, evalDeps(overrides));

  async function resultsOf(runId: string) {
    return appDb.select().from(evalResults).where(eq(evalResults.runId, runId));
  }

  async function runRow(runId: string) {
    const [row] = await appDb.select().from(evalRuns).where(eq(evalRuns.id, runId));
    if (!row) throw new Error('No run');
    return row;
  }

  beforeAll(async () => {
    await dropDatabase(DB_NAME);
    url = await createDatabase(DB_NAME);
    await run('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_URL_DIRECT: url } });

    const pool = new Pool({ connectionString: url });
    const seed = drizzle(pool, { schema: { documents, chunks } });
    for (const [slug, accessRoles] of [
      ['msa-harbor', ['sales', 'admin']],
      ['hr-handbook', ['hr', 'admin']],
    ] as const) {
      const [document] = await seed
        .insert(documents)
        .values({
          slug,
          title: slug,
          docType: 'msa',
          accessRoles: [...accessRoles],
          sourcePath: `data/corpus/${slug}.docx`,
          checksum: slug,
          chunkerVersion: 'test',
        })
        .returning({ id: documents.id });
      if (!document) throw new Error('No document');
      const content = `Late delivery terms of ${slug}.`;
      await seed.insert(chunks).values({
        documentId: document.id,
        ordinal: 0,
        sectionRef: '1',
        sectionTitle: 'Terms',
        contextPrefix: slug,
        content,
        charStart: 0,
        charEnd: content.length,
        tokenCount: 10,
        embedding: VECTOR,
        embeddingModel: 'fake-embedding',
      });
    }
    await pool.end();

    fixtureDir = await mkdtemp(path.join(tmpdir(), 'ridgeline-eval-runner-'));
    questionsPath = path.join(fixtureDir, 'questions.json');
    await writeFile(questionsPath, JSON.stringify([...DEV_QUESTIONS, ...TEST_QUESTIONS]));

    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('CHAT_MODEL', 'gpt-5-mini');
    vi.stubEnv('EMBEDDING_MODEL', 'text-embedding-3-small');
    vi.stubEnv('SIM_FLOOR', '0.3');
    for (const [name, value] of Object.entries(CLI_ENV)) vi.stubEnv(name, value);

    ({ runEval } = await import('@/server/eval/runner'));
    const client = await import('@/server/db/client');
    appDb = client.db;
    closeAppPool = () => client.pool.end();
  });

  afterAll(async () => {
    await closeAppPool();
    vi.unstubAllEnvs();
    await dropDatabase(DB_NAME);
    await rm(fixtureDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await appDb.delete(evalRuns);
    await appDb.delete(evalQuestions);
    await appDb.delete(requestTraces);
  });

  it('runs a split: one run, a result per question, every metric, the run config', async () => {
    const { runId, total, failures, metrics } = await start({ split: 'dev', label: 'smoke' });

    expect({ total, failures }).toEqual({ total: 3, failures: [] });
    expect(await resultsOf(runId)).toHaveLength(3);
    expect(await appDb.select().from(evalRuns)).toHaveLength(1);

    const row = await runRow(runId);
    expect(row).toMatchObject({
      label: 'smoke',
      split: 'dev',
      model: 'gpt-5-mini',
      embeddingModel: 'text-embedding-3-small',
      judgeModel: null,
      gitSha: 'abc1234',
      datasetVersion: DATASET,
      retrievalConfig: {
        k: 60,
        vectorTopK: 20,
        ftsTopK: 20,
        finalK: 8,
        perDocCap: 3,
        simFloor: 0.3,
      },
    });
    expect(row.promptVersion).toMatch(/^rag-system@v1#/);
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(row.metrics).toEqual(JSON.parse(JSON.stringify(metrics)));
    expect(Object.keys(metrics?.overall ?? {})).toEqual(expect.arrayContaining([...METRIC_KEYS]));
    expect(metrics?.overall).toMatchObject({
      questions: 3,
      retrievalHitRate: 1,
      leakCount: 0,
      refusalAccuracy: 1,
      falseRefusalRate: 0,
      citationValidity: 1,
    });
    expect(Object.keys(metrics?.byCategory ?? {}).sort()).toEqual([
      'direct',
      'no_answer',
      'other_role',
    ]);
  });

  it('writes retrieved candidates, the trace link and eval traces under the question role', async () => {
    const { runId } = await start({ split: 'dev' });

    const results = await resultsOf(runId);
    const traces = await appDb.select().from(requestTraces);
    expect(traces).toHaveLength(3);
    for (const trace of traces) {
      expect(trace).toMatchObject({ source: 'eval', account: 'eval', role: 'sales' });
    }
    for (const result of results) {
      expect(traces.map(({ id }) => id)).toContain(result.traceId);
      // Sales reads only msa-harbor: the role filter holds under eval too.
      expect(result.retrieved.map(({ slug }) => slug)).toEqual(['msa-harbor']);
      expect(result.latencyMs).toEqual(expect.any(Number));
    }
    const answered = results.filter(({ refused }) => !refused);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.citedChunkIds).toEqual([answered[0]?.retrieved[0]?.chunkId]);
    expect(answered[0]?.scores).toMatchObject({ retrievalHit: true, citationsValid: 1 });
  });

  it('imports the questions only when the dataset version has none', async () => {
    await start({ split: 'dev' });
    expect(await appDb.select().from(evalQuestions)).toHaveLength(15);

    await appDb.delete(evalQuestions).where(eq(evalQuestions.slug, 'direct-10'));
    await start({ split: 'dev' });

    expect(await appDb.select().from(evalQuestions)).toHaveLength(14);
  });

  it('applies the sim floor it was given to the gate and records it', async () => {
    const lowSim = { embed: async () => ({ embedding: LOW_SIM_VECTOR, tokens: 9 }) };

    const refused = await start({ split: 'dev', simFloor: 0.3 }, lowSim);
    const answered = await start({ split: 'dev', simFloor: 0.05 }, lowSim);

    const directRefused = (await resultsOf(refused.runId)).filter(({ refused }) => refused);
    expect(directRefused).toHaveLength(3);
    expect(refused.metrics?.overall.falseRefusalRate).toBe(1);
    expect(answered.metrics?.overall.falseRefusalRate).toBe(0);
    expect((await runRow(answered.runId)).retrievalConfig.simFloor).toBe(0.05);
    const traces = await appDb.select().from(requestTraces);
    expect(traces.map(({ retrieval }) => retrieval.simFloor).sort()).toEqual([
      0.05, 0.05, 0.05, 0.3, 0.3, 0.3,
    ]);
  });

  it('fails before the run on an expected document that is not ingested', async () => {
    const missing = path.join(fixtureDir, 'missing-doc.json');
    await writeFile(
      missing,
      JSON.stringify([questionFixture('direct-01', 'dev', { expectedDocSlugs: ['no-such-doc'] })]),
    );
    const llm = modelReplies(() => 'The fact [1]');

    await expect(start({ split: 'dev' }, { questionsPath: missing, llm })).rejects.toThrow(
      'no-such-doc',
    );
    expect(llm).not.toHaveBeenCalled();
    expect(await appDb.select().from(evalRuns)).toEqual([]);
  });

  describe('resume', () => {
    // The stream fails on 7 of the 12 questions, which leaves the run after 5 results.
    function failingAfterFive() {
      let calls = 0;
      return vi.fn(async (messages) => {
        calls += 1;
        if (calls > 5) throw new Error('model down');
        return modelReplies(() => 'The fact [1]')(messages, new AbortController().signal);
      }) as StreamChat;
    }

    it('finishes the 7 left of an interrupted run of 12 without duplicates', async () => {
      const first = await start({ split: 'test' }, { llm: failingAfterFive() });

      expect(first.metrics).toBeNull();
      expect(first.failures).toHaveLength(7);
      expect(first.failures[0]?.reason).toBe('llm_error');
      expect(await resultsOf(first.runId)).toHaveLength(5);
      expect((await runRow(first.runId)).finishedAt).toBeNull();

      const llm = modelReplies(() => 'The fact [1]');
      const second = await start({ resumeRunId: first.runId }, { llm });

      expect(second).toMatchObject({ runId: first.runId, total: 12, skipped: 5, failures: [] });
      expect(llm).toHaveBeenCalledTimes(7);
      expect(await resultsOf(first.runId)).toHaveLength(12);
      expect(await appDb.select().from(evalRuns)).toHaveLength(1);
      expect(second.metrics?.overall.questions).toBe(12);
      expect((await runRow(first.runId)).finishedAt).toBeInstanceOf(Date);
    });

    it('keeps the sim floor the run started with', async () => {
      const first = await start(
        { split: 'test', simFloor: 0.05 },
        {
          llm: failingAfterFive(),
          embed: async () => ({ embedding: LOW_SIM_VECTOR, tokens: 9 }),
        },
      );

      const second = await start(
        { resumeRunId: first.runId },
        { embed: async () => ({ embedding: LOW_SIM_VECTOR, tokens: 9 }) },
      );

      expect(second.metrics?.overall.falseRefusalRate).toBe(0);
    });

    it('stops taking questions once aborted and leaves the run open', async () => {
      const abort = new AbortController();
      const llm = vi.fn(async (messages) => {
        abort.abort();
        return modelReplies(() => 'The fact [1]')(messages, abort.signal);
      }) as StreamChat;

      const { runId, metrics } = await start({ split: 'test' }, { llm, signal: abort.signal });

      expect(metrics).toBeNull();
      expect((await runRow(runId)).finishedAt).toBeNull();
      expect(vi.mocked(llm).mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('refuses an unknown run, a finished run and a changed configuration', async () => {
      const unknown = '00000000-0000-4000-8000-000000000000';
      await expect(start({ resumeRunId: unknown })).rejects.toThrow('not found');

      const { runId } = await start({ split: 'dev' });
      await expect(start({ resumeRunId: runId })).rejects.toThrow('already finished');

      const { promptVersion } = await runRow(runId);
      await appDb
        .update(evalRuns)
        .set({ finishedAt: null, promptVersion: 'rag-system@v0#old' })
        .where(eq(evalRuns.id, runId));
      await expect(start({ resumeRunId: runId })).rejects.toThrow('promptVersion');

      await appDb
        .update(evalRuns)
        .set({ promptVersion, datasetVersion: 'old' })
        .where(eq(evalRuns.id, runId));
      await expect(start({ resumeRunId: runId })).rejects.toThrow('datasetVersion');

      await appDb
        .update(evalRuns)
        .set({ datasetVersion: DATASET, gitSha: 'older-commit' })
        .where(eq(evalRuns.id, runId));
      await expect(start({ resumeRunId: runId })).rejects.toThrow('gitSha');
    });
  });

  describe('pnpm eval', () => {
    function cli(args: string[], extraEnv: Record<string, string> = {}) {
      return run(
        path.join(REPO, 'node_modules/.bin/tsx'),
        ['--conditions=react-server', 'scripts/eval.ts', ...args],
        { cwd: REPO, env: { ...process.env, ...CLI_ENV, DATABASE_URL: url, ...extraEnv } },
      );
    }

    it('stops before the run when the judge has no key', async () => {
      await expect(cli(['--split', 'dev'], { ANTHROPIC_API_KEY: '' })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('ANTHROPIC_API_KEY is not set'),
      });

      expect(await appDb.select().from(evalRuns)).toEqual([]);
      expect(await appDb.select().from(evalQuestions)).toEqual([]);
    });

    it('prints the usage and starts nothing on bad arguments', async () => {
      await expect(cli(['--split', 'staging', '--no-judge'])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Usage: pnpm eval'),
      });

      expect(await appDb.select().from(evalRuns)).toEqual([]);
    });
  });
});
