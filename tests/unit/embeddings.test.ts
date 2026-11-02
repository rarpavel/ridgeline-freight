import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

type Reply = { status: number; headers?: Record<string, string>; body?: unknown };

const DIMENSIONS = 1536;
const HASH = `$2b$10$${'a'.repeat(53)}`;

let server: Server;
let requests: { model: string; input: string[] }[] = [];
let scripted: Reply[] = [];
let embeddings: typeof import('@/server/llm/embeddings');

function vectorsFor(input: string[], length = DIMENSIONS) {
  return input.map((text, index) => ({
    index,
    embedding: new Array<number>(length).fill(Number(text.split('-')[1] ?? 0)),
  }));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as { model: string; input: string[] };
      requests.push(body);
      const reply: Reply = scripted.shift() ?? {
        status: 200,
        body: { data: vectorsFor(body.input) },
      };
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      res.end(JSON.stringify(reply.body ?? { error: { message: 'scripted failure' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  vi.stubEnv('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/ridgeline');
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
  vi.stubEnv('OPENAI_BASE_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  vi.stubEnv('EMBEDDING_MODEL', 'test-embedding-model');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-chars');
  vi.stubEnv(
    'DEMO_ACCOUNTS_JSON',
    JSON.stringify([{ id: 'sales', role: 'sales', passwordHash: HASH }]),
  );
  embeddings = await import('@/server/llm/embeddings');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  scripted = [];
});

describe('embedTexts', () => {
  it('splits the input into batches of 64 and sends the configured model', async () => {
    const texts = Array.from({ length: 130 }, (_, index) => `text-${index}`);

    const vectors = await embeddings.embedTexts(texts);

    expect(requests.map(({ input }) => input.length)).toEqual([64, 64, 2]);
    expect(new Set(requests.map(({ model }) => model))).toEqual(new Set(['test-embedding-model']));
    expect(vectors.map((vector) => vector[0])).toEqual(texts.map((_, index) => index));
  });

  it('makes no request for an empty input', async () => {
    await expect(embeddings.embedTexts([])).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('keeps input order when the API returns items out of order', async () => {
    const input = ['text-0', 'text-1', 'text-2'];
    scripted = [{ status: 200, body: { data: vectorsFor(input).reverse() } }];

    const vectors = await embeddings.embedTexts(input);

    expect(vectors.map((vector) => vector[0])).toEqual([0, 1, 2]);
  });

  it('retries on 429 and 5xx and then succeeds', async () => {
    const headers = { 'retry-after-ms': '1' };
    scripted = [
      { status: 429, headers },
      { status: 500, headers },
      { status: 503, headers },
    ];

    const vectors = await embeddings.embedTexts(['text-7']);

    expect(requests).toHaveLength(4);
    expect(vectors[0]?.[0]).toBe(7);
  });

  it('gives up after the retries are spent', async () => {
    const headers = { 'retry-after-ms': '1' };
    scripted = Array.from({ length: 4 }, () => ({ status: 429, headers }));

    await expect(embeddings.embedTexts(['text-1'])).rejects.toThrow();
    expect(requests).toHaveLength(4);
  });

  it('does not retry a 400', async () => {
    scripted = [{ status: 400 }];

    await expect(embeddings.embedTexts(['text-1'])).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it('rejects a vector whose length is not 1536', async () => {
    const input = ['text-1'];
    scripted = [{ status: 200, body: { data: vectorsFor(input, 3072) } }];

    await expect(embeddings.embedTexts(input)).rejects.toThrow('length 1536, got 3072');
  });

  it('rejects a response with the wrong number of vectors', async () => {
    const input = ['text-1', 'text-2'];
    scripted = [{ status: 200, body: { data: vectorsFor(['text-1']) } }];

    await expect(embeddings.embedTexts(input)).rejects.toThrow('Expected 2 embeddings, got 1');
  });
});
