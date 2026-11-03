import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sealData } from 'iron-session';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/lib/errors';
import type { ChatEvent } from '@/lib/sse';
import { chunks } from '@/server/db/schema/chunks';
import { documents } from '@/server/db/schema/documents';
import { REFUSAL_TEXT } from '@/server/rag/refusal';

import { createDatabase, dropDatabase } from './helpers/database';

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

// The network edge of the real route: everything from generate.ts inwards runs for real.
const fakeOpenai = vi.hoisted(() => ({
  chat: { completions: { create: vi.fn() } },
  embeddings: { create: vi.fn() },
}));
vi.mock('@/server/llm/client', () => ({ openai: fakeOpenai }));

const run = promisify(execFile);

const DB_NAME = `ridgeline_chat_route_${process.pid}`;
const DIMENSIONS = 1536;
const SECRET = 'test-session-secret-at-least-32-chars';
const HASH = `$2b$10$${'a'.repeat(53)}`;
const MSA_TEXT = 'Late delivery penalty is $250.00 per shipment.';
const HR_TEXT = 'Secret salary bands live in this HR policy.';
const QUESTION = 'What is the late delivery penalty?';
const USAGE = { prompt_tokens: 120, completion_tokens: 8 };

const UNCOVERED_QUESTION = 'Which forklift certifications exist?';

const VECTOR = Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
// A unit vector with a cosine of 0.12 to VECTOR, the one every seeded chunk has.
const LOW_SIM_VECTOR = Array.from({ length: DIMENSIONS }, (_, i) => {
  if (i === 0) return 0.12;
  return i === 1 ? Math.sqrt(1 - 0.12 ** 2) : 0;
});

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
    usage: { prompt_tokens: 5, total_tokens: 5 },
  });
}

/** Every event of a finished SSE response, in order. */
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

function chatRequest(body: unknown) {
  return new Request('https://ridgeline.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function signIn(account: string, role: string) {
  const sealed = await sealData({ account, role, issuedAt: Date.now() }, { password: SECRET });
  cookieJar.set('ridgeline_session', sealed);
}

describe('POST /api/chat', () => {
  let POST: (request: Request) => Promise<Response>;
  let answer: typeof import('@/server/rag/answer');
  let closeAppPool: () => Promise<unknown>;
  let msaId: string;
  let msaChunkId: string;

  beforeAll(async () => {
    await dropDatabase(DB_NAME);
    const url = await createDatabase(DB_NAME);
    await run('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_URL_DIRECT: url } });

    const pool = new Pool({ connectionString: url });
    const seed = drizzle(pool, { schema: { documents, chunks } });
    const insert = async (slug: string, title: string, roles: string[], content: string) => {
      const [document] = await seed
        .insert(documents)
        .values({
          slug,
          title,
          docType: 'msa',
          accessRoles: roles,
          sourcePath: `data/corpus/${slug}.docx`,
          checksum: slug,
          chunkerVersion: 'test',
        })
        .returning({ id: documents.id });
      if (!document) throw new Error(`No document for ${slug}`);
      const [chunk] = await seed
        .insert(chunks)
        .values({
          documentId: document.id,
          ordinal: 0,
          sectionRef: '4.3',
          sectionTitle: 'Late Delivery Penalties',
          contextPrefix: title,
          content,
          charStart: 0,
          charEnd: content.length,
          tokenCount: 10,
          embedding: VECTOR,
          embeddingModel: 'fake-embedding',
        })
        .returning({ id: chunks.id });
      if (!chunk) throw new Error(`No chunk for ${slug}`);
      return { documentId: document.id, chunkId: chunk.id };
    };
    const msa = await insert('msa-harbor', 'Harbor Point MSA', ['sales', 'admin'], MSA_TEXT);
    msaId = msa.documentId;
    msaChunkId = msa.chunkId;
    await insert('hr-pay', 'Pay Policy', ['hr', 'admin'], HR_TEXT);
    await pool.end();

    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('CHAT_MODEL', 'test-chat-model');
    vi.stubEnv('SESSION_SECRET', SECRET);
    vi.stubEnv(
      'DEMO_ACCOUNTS_JSON',
      JSON.stringify([{ id: 'sales', role: 'sales', passwordHash: HASH }]),
    );

    ({ POST } = await import('@/app/api/chat/route'));
    answer = await import('@/server/rag/answer');
    const client = await import('@/server/db/client');
    closeAppPool = () => client.pool.end();
  });

  afterAll(async () => {
    await closeAppPool();
    vi.unstubAllEnvs();
    await dropDatabase(DB_NAME);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    cookieJar.clear();
    embeddingIs(VECTOR);
    await signIn('sales', 'sales');
  });

  it('streams meta, deltas, citations and done, and removes an unknown alias', async () => {
    modelStreams([{ text: 'A [1]' }, { text: ' B [' }, { text: '9]' }, { usage: USAGE }]);

    const response = await POST(chatRequest({ question: QUESTION }));
    const events = await readEvents(response);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(events.map(({ event }) => event)).toEqual([
      'meta',
      'delta',
      'delta',
      'delta',
      'citations',
      'done',
    ]);

    const meta = eventOf(events, 'meta')?.data;
    expect(meta?.gate).toBe('answer');
    expect(meta?.model).toBe('test-chat-model');
    expect(meta?.promptVersion).toMatch(/^rag-system@v1#/);
    expect(meta?.traceId).toMatch(/^[0-9a-f-]{36}$/);

    expect(eventOf(events, 'citations')?.data).toEqual({
      valid: [
        {
          n: 1,
          chunkId: msaChunkId,
          documentId: msaId,
          title: 'Harbor Point MSA',
          sectionRef: '4.3',
        },
      ],
      dropped: [9],
      text: 'A [1] B',
    });

    const done = eventOf(events, 'done')?.data;
    expect(done?.refused).toBe(false);
    expect(done?.usage).toEqual({ inputTokens: 120, outputTokens: 8 });
    expect(done?.ttftMs).toEqual(expect.any(Number));
    expect(done?.latencyMs).toEqual(expect.any(Number));
  });

  it('sends the model only passages open to the role, within the output limit', async () => {
    modelStreams([{ text: 'A [1]' }, { usage: USAGE }]);

    await readEvents(await POST(chatRequest({ question: QUESTION })));

    const [params] = fakeOpenai.chat.completions.create.mock.calls[0] ?? [];
    const prompt = JSON.stringify(params.messages);
    expect(prompt).toContain(MSA_TEXT);
    expect(prompt).not.toContain(HR_TEXT);
    expect(params.max_completion_tokens).toBe(700);
    expect(params.stream_options).toEqual({ include_usage: true });
  });

  it('refuses without a session and calls no model', async () => {
    cookieJar.clear();

    const response = await POST(chatRequest({ question: QUESTION }));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('unauthorized');
    expect(fakeOpenai.embeddings.create).not.toHaveBeenCalled();
    expect(fakeOpenai.chat.completions.create).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty question', { question: '   ' }],
    ['a question over the limit', { question: 'x'.repeat(501) }],
    ['a missing question', {}],
  ])('rejects %s and calls no model', async (_, body) => {
    const response = await POST(chatRequest(body));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('validation');
    expect(fakeOpenai.embeddings.create).not.toHaveBeenCalled();
    expect(fakeOpenai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('ends with an error event when the model fails after the first token', async () => {
    modelStreams([{ text: 'A [1]' }, { fail: new Error('upstream secret detail') }]);

    const response = await POST(chatRequest({ question: QUESTION }));
    const events = await readEvents(response);

    expect(response.status).toBe(200);
    expect(events.map(({ event }) => event)).toEqual(['meta', 'delta', 'error']);
    expect(eventOf(events, 'error')?.data).toEqual({
      code: 'llm_error',
      message: 'The model is unavailable, please retry.',
    });
  });

  it('ends with an error event when the model call itself fails', async () => {
    fakeOpenai.chat.completions.create.mockRejectedValue(new Error('connection refused'));

    const response = await POST(chatRequest({ question: QUESTION }));
    const events = await readEvents(response);

    expect(response.status).toBe(200);
    expect(events.map(({ event }) => event)).toEqual(['meta', 'error']);
    expect(eventOf(events, 'error')?.data.code).toBe('llm_error');
  });

  it('counts tokens itself when the model sends no usage', async () => {
    modelStreams([{ text: 'The penalty is $250.00 [1].' }]);

    const events = await readEvents(await POST(chatRequest({ question: QUESTION })));

    const usage = eventOf(events, 'done')?.data.usage;
    expect(usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.outputTokens).toBeGreaterThan(0);
  });

  it('reports a model refusal in done, without the marker', async () => {
    modelStreams([{ text: 'NO_ANSWER: Not in the documents.' }, { usage: USAGE }]);

    const events = await readEvents(await POST(chatRequest({ question: QUESTION })));

    expect(eventOf(events, 'citations')?.data).toEqual({
      valid: [],
      dropped: [],
      text: 'Not in the documents.',
    });
    expect(eventOf(events, 'done')?.data).toMatchObject({ refused: true, reason: 'model' });
  });

  it('refuses at the gate without a model call when both signals are weak', async () => {
    embeddingIs(LOW_SIM_VECTOR);

    const events = await readEvents(await POST(chatRequest({ question: UNCOVERED_QUESTION })));

    expect(events.map(({ event }) => event)).toEqual(['meta', 'delta', 'citations', 'done']);
    expect(eventOf(events, 'meta')?.data.gate).toBe('refuse');
    expect(eventOf(events, 'citations')?.data).toEqual({
      valid: [],
      dropped: [],
      text: REFUSAL_TEXT,
    });
    expect(eventOf(events, 'done')?.data).toMatchObject({
      refused: true,
      reason: 'gate',
      usage: { inputTokens: 0, outputTokens: 0 },
      ttftMs: null,
    });
    expect(fakeOpenai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('calls the model on a weak similarity when FTS found something', async () => {
    embeddingIs(LOW_SIM_VECTOR);
    modelStreams([{ text: 'A [1]' }, { usage: USAGE }]);

    const events = await readEvents(await POST(chatRequest({ question: 'late delivery penalty' })));

    expect(eventOf(events, 'meta')?.data.gate).toBe('answer');
    expect(eventOf(events, 'done')?.data).toMatchObject({ refused: false, reason: null });
    expect(fakeOpenai.chat.completions.create).toHaveBeenCalledOnce();
  });

  it('does not let FTS matches in another role keep a question past the gate', async () => {
    embeddingIs(LOW_SIM_VECTOR);

    const response = await POST(chatRequest({ question: 'secret salary bands' }));
    const body = await response.text();

    expect(body).toContain('"gate":"refuse"');
    expect(body).not.toContain(HR_TEXT);
    expect(fakeOpenai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('refuses at the gate when the embedding call fails and FTS found nothing', async () => {
    fakeOpenai.embeddings.create.mockRejectedValue(new Error('embedder down'));

    const events = await readEvents(await POST(chatRequest({ question: UNCOVERED_QUESTION })));

    expect(eventOf(events, 'done')?.data).toMatchObject({ refused: true, reason: 'gate' });
    expect(fakeOpenai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('turns a model answer without citations into a refusal', async () => {
    modelStreams([{ text: 'The penalty is $250.00.' }, { usage: USAGE }]);

    const events = await readEvents(await POST(chatRequest({ question: QUESTION })));

    expect(eventOf(events, 'meta')?.data.gate).toBe('answer');
    expect(eventOf(events, 'citations')?.data).toEqual({
      valid: [],
      dropped: [],
      text: REFUSAL_TEXT,
    });
    expect(eventOf(events, 'done')?.data).toMatchObject({
      refused: true,
      reason: 'no_valid_citations',
      usage: { inputTokens: 120, outputTokens: 8 },
    });
  });

  it('answers from FTS alone when the embedding call fails', async () => {
    fakeOpenai.embeddings.create.mockRejectedValue(new Error('embedder down'));
    modelStreams([{ text: 'A [1]' }, { usage: USAGE }]);

    const events = await readEvents(await POST(chatRequest({ question: 'late delivery penalty' })));

    expect(eventOf(events, 'citations')?.data.valid).toHaveLength(1);
    expect(eventOf(events, 'done')).toBeDefined();
  });

  it('aborts the model call when the client disconnects', async () => {
    let modelSignal: AbortSignal | undefined;
    fakeOpenai.chat.completions.create.mockImplementation(
      async (_params: unknown, { signal }: { signal: AbortSignal }) => {
        modelSignal = signal;
        return (async function* () {
          yield { choices: [{ delta: { content: 'A' } }], usage: null };
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
          });
        })();
      },
    );

    const response = await POST(chatRequest({ question: QUESTION }));
    const reader = response.body?.getReader();
    await reader?.read(); // meta
    await reader?.read(); // first delta
    await reader?.cancel();

    expect(modelSignal?.aborted).toBe(true);
  });

  describe('answerQuestion', () => {
    const user = { account: 'sales', role: 'sales' } as const;
    const embed = async () => ({ embedding: VECTOR, tokens: 5 });

    async function collect(events: AsyncIterable<ChatEvent>) {
      const collected: ChatEvent[] = [];
      for await (const event of events) collected.push(event);
      return collected;
    }

    it('turns a failed query into a db_error event', async () => {
      const failingDb = {
        transaction: () => Promise.reject(new AppError('db_error', 'Retrieval query failed')),
      };

      const events = await collect(
        answer.answerQuestion(
          { question: QUESTION, user },
          {
            db: failingDb as never,
            embed,
            llm: fakeOpenai.chat.completions.create,
            signal: new AbortController().signal,
          },
        ),
      );

      expect(events.map(({ event }) => event)).toEqual(['error']);
      expect(eventOf(events, 'error')?.data.code).toBe('db_error');
      expect(fakeOpenai.chat.completions.create).not.toHaveBeenCalled();
    });

    it('gives up on a model that stays silent past the timeout', async () => {
      const { db } = await import('@/server/db/client');

      const events = await collect(
        answer.answerQuestion(
          { question: QUESTION, user },
          {
            db,
            embed,
            llm: async (_messages, signal) =>
              (async function* () {
                await new Promise((_, reject) => {
                  signal.addEventListener('abort', () => reject(signal.reason));
                });
              })(),
            signal: new AbortController().signal,
            llmTimeoutMs: 10,
          },
        ),
      );

      expect(events.map(({ event }) => event)).toEqual(['meta', 'error']);
      expect(eventOf(events, 'error')?.data.code).toBe('llm_error');
    });
  });
});
