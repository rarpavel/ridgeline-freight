import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sealData } from 'iron-session';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatEvent } from '@/lib/sse';
import { chunks } from '@/server/db/schema/chunks';
import { documents } from '@/server/db/schema/documents';
import { requestTraces } from '@/server/db/schema/request-traces';

import pricing from '../../config/pricing.json';
import { createDatabase, dropDatabase } from './helpers/database';

vi.mock('server-only', () => ({}));

const fakeLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/server/logger', () => ({ logger: fakeLogger }));

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

const DB_NAME = `ridgeline_trace_${process.pid}`;
const DIMENSIONS = 1536;
const SECRET = 'test-session-secret-at-least-32-chars';
const OPENAI_KEY = 'test-openai-key';
const HASH = `$2b$10$${'a'.repeat(53)}`;
const FIRST_TEXT = 'Late delivery penalty is $250.00 per shipment.';
const SECOND_TEXT = 'Late delivery credits are capped at $5,000.00 per month.';
const QUESTION = 'What is the late delivery penalty?';
const UNCOVERED_QUESTION = 'Which forklift certifications exist?';
const USAGE = { prompt_tokens: 1000, completion_tokens: 200 };
const EMBEDDING_TOKENS = 9;

const VECTOR = Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
const LOW_SIM_VECTOR = Array.from({ length: DIMENSIONS }, (_, i) => {
  if (i === 0) return 0.12;
  return i === 1 ? Math.sqrt(1 - 0.12 ** 2) : 0;
});

const EMBEDDING_COST =
  (EMBEDDING_TOKENS / 1e6) * pricing.models['text-embedding-3-small'].inputPer1M;
const CHAT_COST =
  (USAGE.prompt_tokens / 1e6) * pricing.models['gpt-5-mini'].inputPer1M +
  (USAGE.completion_tokens / 1e6) * pricing.models['gpt-5-mini'].outputPer1M;

type Part = { text: string } | { usage: typeof USAGE } | { fail: Error };

async function* completion(parts: Part[]) {
  for (const part of parts) {
    if ('fail' in part) throw part.fail;
    if ('text' in part) {
      yield { choices: [{ delta: { content: part.text } }], usage: null };
    } else {
      yield { choices: [], usage: part.usage };
    }
  }
}

function modelStreams(parts: Part[]) {
  fakeOpenai.chat.completions.create.mockResolvedValue(completion(parts));
}

function embeddingIs(embedding: number[]) {
  fakeOpenai.embeddings.create.mockResolvedValue({
    data: [{ index: 0, embedding }],
    usage: { prompt_tokens: EMBEDDING_TOKENS, total_tokens: EMBEDDING_TOKENS },
  });
}

async function readEvents(response: Response): Promise<ChatEvent[]> {
  const body = await response.text();
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const [eventLine, dataLine] = frame.split('\n');
      return {
        event: eventLine?.replace('event: ', ''),
        data: JSON.parse(dataLine?.replace('data: ', '') ?? 'null'),
      } as ChatEvent;
    });
}

function eventOf<Name extends ChatEvent['event']>(events: ChatEvent[], name: Name) {
  return events.find((e) => e.event === name) as Extract<ChatEvent, { event: Name }> | undefined;
}

function chatRequest(question: string) {
  return new Request('https://ridgeline.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
  });
}

describe('request_traces', () => {
  let POST: (request: Request) => Promise<Response>;
  let answer: typeof import('@/server/rag/answer');
  let appDb: typeof import('@/server/db/client').db;
  let closeAppPool: () => Promise<unknown>;
  let sealedSession: string;
  let firstChunkId: string;
  let secondChunkId: string;
  let firstDocumentId: string;

  async function allTraces() {
    return appDb.select().from(requestTraces);
  }

  async function onlyTrace() {
    const rows = await allTraces();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (!row) throw new Error('No trace');
    return row;
  }

  beforeAll(async () => {
    await dropDatabase(DB_NAME);
    const url = await createDatabase(DB_NAME);
    await run('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_URL_DIRECT: url } });

    const pool = new Pool({ connectionString: url });
    const seed = drizzle(pool, { schema: { documents, chunks } });
    const [document] = await seed
      .insert(documents)
      .values({
        slug: 'msa-harbor',
        title: 'Harbor Point MSA',
        docType: 'msa',
        accessRoles: ['sales', 'admin'],
        sourcePath: 'data/corpus/msa-harbor.docx',
        checksum: 'msa-harbor',
        chunkerVersion: 'test',
      })
      .returning({ id: documents.id });
    if (!document) throw new Error('No document');
    firstDocumentId = document.id;
    const rows = await seed
      .insert(chunks)
      .values(
        [FIRST_TEXT, SECOND_TEXT].map((content, ordinal) => ({
          documentId: document.id,
          ordinal,
          sectionRef: `4.${ordinal + 3}`,
          sectionTitle: 'Late Delivery',
          contextPrefix: 'Harbor Point MSA',
          content,
          charStart: 0,
          charEnd: content.length,
          tokenCount: 10,
          embedding: VECTOR,
          embeddingModel: 'fake-embedding',
        })),
      )
      .returning({ id: chunks.id, ordinal: chunks.ordinal });
    firstChunkId = rows.find(({ ordinal }) => ordinal === 0)?.id ?? '';
    secondChunkId = rows.find(({ ordinal }) => ordinal === 1)?.id ?? '';
    await pool.end();

    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('OPENAI_API_KEY', OPENAI_KEY);
    vi.stubEnv('CHAT_MODEL', 'gpt-5-mini');
    vi.stubEnv('EMBEDDING_MODEL', 'text-embedding-3-small');
    vi.stubEnv('SIM_FLOOR', '0.3');
    vi.stubEnv('SESSION_SECRET', SECRET);
    vi.stubEnv(
      'DEMO_ACCOUNTS_JSON',
      JSON.stringify([{ id: 'sales', role: 'sales', passwordHash: HASH }]),
    );

    ({ POST } = await import('@/app/api/chat/route'));
    answer = await import('@/server/rag/answer');
    const client = await import('@/server/db/client');
    appDb = client.db;
    closeAppPool = () => client.pool.end();
    sealedSession = await sealData(
      { account: 'sales', role: 'sales', issuedAt: Date.now() },
      { password: SECRET },
    );
  });

  afterAll(async () => {
    await closeAppPool();
    vi.unstubAllEnvs();
    await dropDatabase(DB_NAME);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    cookieJar.clear();
    cookieJar.set('ridgeline_session', sealedSession);
    embeddingIs(VECTOR);
    await appDb.delete(requestTraces);
  });

  it('records an answer with 2 valid and 1 dropped citation', async () => {
    modelStreams([{ text: 'A [1] and B [2] and C [9]' }, { usage: USAGE }]);

    const events = await readEvents(await POST(chatRequest(QUESTION)));
    const trace = await onlyTrace();

    expect(trace).toMatchObject({
      id: eventOf(events, 'meta')?.data.traceId,
      source: 'chat',
      account: 'sales',
      role: 'sales',
      question: QUESTION,
      embeddingModel: 'text-embedding-3-small',
      gate: 'answer',
      model: 'gpt-5-mini',
      inputTokens: 1000,
      outputTokens: 200,
      refused: false,
      refusalReason: null,
      citationsValid: 2,
      citationsDropped: 1,
      generatedText: 'A [1] and B [2] and C [9]',
      error: null,
    });
    expect(trace.promptVersion).toMatch(/^rag-system@v1#/);
    expect(trace.costUsd).toBeCloseTo(EMBEDDING_COST + CHAT_COST, 6);
    expect(trace.ttftMs).toEqual(expect.any(Number));
    expect(trace.latencyMs).toEqual(expect.any(Number));
    expect(eventOf(events, 'done')?.data.costUsd).toBeCloseTo(EMBEDDING_COST + CHAT_COST, 6);
  });

  it('keeps every candidate with its scores and marks the cited ones', async () => {
    modelStreams([{ text: 'A [1]' }, { usage: USAGE }]);

    await readEvents(await POST(chatRequest(QUESTION)));
    const { retrieval } = await onlyTrace();

    expect(retrieval).toMatchObject({
      simFloor: 0.3,
      ftsMatches: 2,
      ftsAllTermsMatches: 1,
      vectorUnavailable: false,
    });
    expect(retrieval.bestSim).toBeCloseTo(1);
    const byChunk = new Map(retrieval.candidates.map((c) => [c.chunkId, c]));
    expect(retrieval.candidates).toHaveLength(2);
    expect(byChunk.get(firstChunkId)).toMatchObject({
      documentId: firstDocumentId,
      slug: 'msa-harbor',
      sectionRef: '4.3',
      vectorRank: expect.any(Number),
      ftsRank: expect.any(Number),
      rrf: expect.any(Number),
      inPrompt: true,
    });
    const cited = retrieval.candidates.filter((candidate) => candidate.cited);
    expect(cited).toHaveLength(1);
    expect([firstChunkId, secondChunkId]).toContain(cited[0]?.chunkId);
  });

  it('records a gate refusal with no model and the embedding cost alone', async () => {
    embeddingIs(LOW_SIM_VECTOR);

    const events = await readEvents(await POST(chatRequest(UNCOVERED_QUESTION)));
    const trace = await onlyTrace();

    expect(trace).toMatchObject({
      gate: 'refuse_gate',
      model: null,
      promptVersion: null,
      inputTokens: null,
      outputTokens: null,
      ttftMs: null,
      refused: true,
      refusalReason: 'gate',
      generatedText: null,
      citationsValid: 0,
      citationsDropped: 0,
    });
    expect(trace.costUsd).toBeCloseTo(EMBEDDING_COST, 6);
    // Retrieval still found candidates, but no prompt was built from them.
    expect(trace.retrieval.candidates.length).toBeGreaterThan(0);
    expect(trace.retrieval.candidates.filter(({ inPrompt, cited }) => inPrompt || cited)).toEqual(
      [],
    );
    expect(eventOf(events, 'done')?.data.costUsd).toBeCloseTo(EMBEDDING_COST, 6);
    expect(fakeOpenai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('records a model refusal with what the model wrote', async () => {
    modelStreams([{ text: 'NO_ANSWER: Not in the documents.' }, { usage: USAGE }]);

    await readEvents(await POST(chatRequest(QUESTION)));

    expect(await onlyTrace()).toMatchObject({
      gate: 'answer',
      refused: true,
      refusalReason: 'model',
      generatedText: 'NO_ANSWER: Not in the documents.',
    });
  });

  it('records the original text of an answer replaced for having no citations', async () => {
    modelStreams([{ text: 'The penalty is $250.00.' }, { usage: USAGE }]);

    await readEvents(await POST(chatRequest(QUESTION)));

    expect(await onlyTrace()).toMatchObject({
      refused: true,
      refusalReason: 'no_valid_citations',
      generatedText: 'The penalty is $250.00.',
      citationsValid: 0,
    });
  });

  it('records no embedding model or cost when the embedding call fails', async () => {
    fakeOpenai.embeddings.create.mockRejectedValue(new Error('embedder down'));

    await readEvents(await POST(chatRequest(UNCOVERED_QUESTION)));
    const trace = await onlyTrace();

    expect(trace).toMatchObject({ embeddingModel: null, costUsd: null, gate: 'refuse_gate' });
    expect(trace.retrieval.vectorUnavailable).toBe(true);
  });

  it('records a model failure with the error code and the partial text', async () => {
    modelStreams([{ text: 'A [1]' }, { fail: new Error('upstream secret detail') }]);

    const events = await readEvents(await POST(chatRequest(QUESTION)));
    const trace = await onlyTrace();

    expect(eventOf(events, 'error')?.data.code).toBe('llm_error');
    expect(trace).toMatchObject({
      error: 'llm_error',
      generatedText: 'A [1]',
      inputTokens: null,
      outputTokens: null,
    });
    expect(trace.costUsd).toBeCloseTo(EMBEDDING_COST, 6);
    expect(trace.latencyMs).toEqual(expect.any(Number));
  });

  it('records a client that disconnects during the answer', async () => {
    fakeOpenai.chat.completions.create.mockImplementation(
      async (_params: unknown, { signal }: { signal: AbortSignal }) =>
        (async function* () {
          yield { choices: [{ delta: { content: 'A' } }], usage: null };
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
          });
        })(),
    );

    const response = await POST(chatRequest(QUESTION));
    const reader = response.body?.getReader();
    await reader?.read(); // meta
    await reader?.read(); // first delta
    await reader?.cancel();

    expect(await onlyTrace()).toMatchObject({
      error: 'client_disconnected',
      generatedText: 'A',
      refused: false,
    });
    expect(fakeLogger.error).not.toHaveBeenCalled();
  });

  it('records a client that disconnects while the stream waits to be read', async () => {
    modelStreams([{ text: 'A [1]' }, { usage: USAGE }]);

    const events = answer.answerQuestion(
      { question: QUESTION, user: { account: 'sales', role: 'sales' } },
      {
        db: appDb,
        embed: async () => ({ embedding: VECTOR, tokens: EMBEDDING_TOKENS }),
        llm: fakeOpenai.chat.completions.create,
        signal: new AbortController().signal,
      },
    );
    await events.next(); // meta
    await events.return(undefined);

    expect(await onlyTrace()).toMatchObject({ error: 'client_disconnected' });
  });

  it('writes the trace before the stream closes, and only once', async () => {
    modelStreams([{ text: 'A [1]' }, { usage: USAGE }]);

    const response = await POST(chatRequest(QUESTION));
    expect(await allTraces()).toEqual([]);

    const events = await readEvents(response);
    const traceId = eventOf(events, 'meta')?.data.traceId ?? '';

    expect(
      await appDb.select().from(requestTraces).where(eq(requestTraces.id, traceId)),
    ).toHaveLength(1);
    expect(await allTraces()).toHaveLength(1);
  });

  it('records a failed retrieval as an error, not as a refusal', async () => {
    const failingRetrieval = {
      transaction: () => Promise.reject(new Error('connection lost')),
      insert: appDb.insert.bind(appDb),
    };

    const events: ChatEvent[] = [];
    for await (const event of answer.answerQuestion(
      { question: QUESTION, user: { account: 'sales', role: 'sales' } },
      {
        db: failingRetrieval as never,
        embed: async () => ({ embedding: VECTOR, tokens: EMBEDDING_TOKENS }),
        llm: fakeOpenai.chat.completions.create,
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events.map(({ event }) => event)).toEqual(['error']);
    const trace = await onlyTrace();
    expect(trace).toMatchObject({ gate: 'answer', refused: false, error: 'db_error' });
    expect(trace.retrieval.candidates).toEqual([]);
  });

  it('still finishes the answer when the trace cannot be written', async () => {
    modelStreams([{ text: 'A [1]' }, { usage: USAGE }]);
    const failingInsert = Object.create(appDb) as typeof appDb;
    failingInsert.insert = (() => {
      throw new Error(`Failed query with params: ${QUESTION}`);
    }) as never;

    const events: ChatEvent[] = [];
    for await (const event of answer.answerQuestion(
      { question: QUESTION, user: { account: 'sales', role: 'sales' } },
      {
        db: failingInsert,
        embed: async () => ({ embedding: VECTOR, tokens: EMBEDDING_TOKENS }),
        llm: fakeOpenai.chat.completions.create,
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events.at(-1)?.event).toBe('done');
    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: expect.any(String) }),
      'chat.trace_failed',
    );
  });

  it('logs chat.done with the trace id and its numbers', async () => {
    modelStreams([{ text: 'A [1] and C [9]' }, { usage: USAGE }]);

    const events = await readEvents(await POST(chatRequest(QUESTION)));

    const done = fakeLogger.info.mock.calls.find(([, msg]) => msg === 'chat.done')?.[0];
    expect(done).toMatchObject({
      traceId: eventOf(events, 'meta')?.data.traceId,
      route: '/api/chat',
      account: 'sales',
      role: 'sales',
      gate: 'answer',
      refused: false,
      inputTokens: 1000,
      outputTokens: 200,
      citationsValid: 1,
      citationsDropped: 1,
      durationMs: expect.any(Number),
    });
    expect(done.costUsd).toBeCloseTo(EMBEDDING_COST + CHAT_COST, 6);
  });

  it('logs chat.error with the trace id', async () => {
    modelStreams([{ fail: new Error('upstream') }]);

    await readEvents(await POST(chatRequest(QUESTION)));

    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: expect.any(String), code: 'llm_error' }),
      'chat.error',
    );
  });

  it('logs no key, cookie, question, passage or answer', async () => {
    const answerText = 'A distinctive generated answer [1] [9]';
    modelStreams([{ text: answerText }, { usage: USAGE }]);

    await readEvents(await POST(chatRequest(QUESTION)));

    const logged = JSON.stringify([
      ...fakeLogger.info.mock.calls,
      ...fakeLogger.warn.mock.calls,
      ...fakeLogger.error.mock.calls,
    ]);
    expect(logged).toContain('chat.done');
    for (const secret of [
      OPENAI_KEY,
      SECRET,
      sealedSession,
      QUESTION,
      FIRST_TEXT,
      SECOND_TEXT,
      'distinctive generated answer',
      'NO_ANSWER',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
