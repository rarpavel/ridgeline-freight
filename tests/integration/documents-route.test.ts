import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { sealData } from 'iron-session';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Role } from '@/server/auth/session';
import { chunks } from '@/server/db/schema/chunks';
import { documents, documentTexts } from '@/server/db/schema/documents';

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

const DB_NAME = `ridgeline_documents_route_${process.pid}`;
const SECRET = 'test-session-secret-at-least-32-chars';
const HASH = `$2b$10$${'a'.repeat(53)}`;
const FIXTURE = 'tests/fixtures/policy.docx';
const HR_TEXT = '# PTO Policy\n## 1. Accrual\nEmployees accrue 1.5 days per month.';
const SECTIONS = [
  { ref: '', title: 'PTO Policy', charStart: 0, charEnd: 12 },
  { ref: '1', title: 'Accrual', charStart: 13, charEnd: 63 },
];
const CHUNK_RANGE = { charStart: 27, charEnd: 63 };

describe('document routes', () => {
  let getDocument: typeof import('@/app/api/documents/[id]/route').GET;
  let getOriginal: typeof import('@/app/api/documents/[id]/original/route').GET;
  let appDb: typeof import('@/server/db/client').db;
  let closeAppPool: () => Promise<unknown>;
  let hrDocumentId: string;
  let hrChunkId: string;
  let msaChunkId: string;

  async function signInAs(role: Role) {
    cookieJar.set(
      'ridgeline_session',
      await sealData({ account: role, role, issuedAt: Date.now() }, { password: SECRET }),
    );
  }

  function fetchDocument(id: string, chunk?: string) {
    const query = chunk === undefined ? '' : `?chunk=${chunk}`;
    return getDocument(new Request(`https://ridgeline.test/api/documents/${id}${query}`), {
      params: Promise.resolve({ id }),
    });
  }

  function fetchOriginal(id: string) {
    return getOriginal(new Request(`https://ridgeline.test/api/documents/${id}/original`), {
      params: Promise.resolve({ id }),
    });
  }

  async function insertDocument(slug: string, accessRoles: Role[], sourcePath: string) {
    const [document] = await appDb
      .insert(documents)
      .values({
        slug,
        title: slug,
        docType: 'hr_policy',
        accessRoles,
        sourcePath,
        checksum: 'checksum',
        chunkerVersion: 'v2',
      })
      .returning({ id: documents.id });
    if (!document) throw new Error('insert returned no row');
    await appDb
      .insert(documentTexts)
      .values({ documentId: document.id, text: HR_TEXT, sections: SECTIONS });
    const [chunk] = await appDb
      .insert(chunks)
      .values({
        documentId: document.id,
        ordinal: 0,
        contextPrefix: slug,
        content: HR_TEXT.slice(CHUNK_RANGE.charStart, CHUNK_RANGE.charEnd),
        ...CHUNK_RANGE,
        tokenCount: 10,
        embedding: new Array<number>(1536).fill(0),
        embeddingModel: 'text-embedding-3-small',
      })
      .returning({ id: chunks.id });
    if (!chunk) throw new Error('insert returned no row');
    return { documentId: document.id, chunkId: chunk.id };
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

    ({ GET: getDocument } = await import('@/app/api/documents/[id]/route'));
    ({ GET: getOriginal } = await import('@/app/api/documents/[id]/original/route'));
    const client = await import('@/server/db/client');
    appDb = client.db;
    closeAppPool = () => client.pool.end();

    const hr = await insertDocument('hr-pto-policy', ['hr', 'admin'], FIXTURE);
    hrDocumentId = hr.documentId;
    hrChunkId = hr.chunkId;
    const msa = await insertDocument('msa-sample', ['sales', 'admin'], 'data/corpus/msa/none.docx');
    msaChunkId = msa.chunkId;
  });

  afterAll(async () => {
    await closeAppPool();
    vi.unstubAllEnvs();
    await dropDatabase(DB_NAME);
  });

  beforeEach(() => {
    cookieJar.clear();
  });

  describe('GET /api/documents/:id', () => {
    it('answers 401 without a session', async () => {
      const response = await fetchDocument(hrDocumentId);

      expect(response.status).toBe(401);
    });

    it('returns the text, sections and chunk range to an allowed role, never cached', async () => {
      await signInAs('hr');

      const response = await fetchDocument(hrDocumentId, hrChunkId);

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        id: hrDocumentId,
        title: 'hr-pto-policy',
        text: HR_TEXT,
        sections: SECTIONS,
        chunk: CHUNK_RANGE,
      });
    });

    it('answers 403 to another role and returns no part of the document', async () => {
      await signInAs('sales');

      const response = await fetchDocument(hrDocumentId, hrChunkId);
      const body = await response.text();

      expect(response.status).toBe(403);
      expect(body).not.toContain('accrue');
      expect(body).not.toContain('hr-pto-policy');
      expect(JSON.parse(body)).toMatchObject({ error: { code: 'forbidden' } });
    });

    it('lets admin read every document', async () => {
      await signInAs('admin');

      const response = await fetchDocument(hrDocumentId);

      expect(response.status).toBe(200);
    });

    it('answers 404 to an unknown id and to one that is not a uuid', async () => {
      await signInAs('admin');

      expect((await fetchDocument(randomUUID())).status).toBe(404);
      expect((await fetchDocument('not-a-uuid')).status).toBe(404);
    });

    it('leaves out the range without a chunk, or with one that does not apply', async () => {
      await signInAs('admin');

      for (const chunk of [undefined, 'not-a-uuid', randomUUID(), msaChunkId]) {
        const response = await fetchDocument(hrDocumentId, chunk);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ chunk: null });
      }
    });

    it('does not expose where the file is stored', async () => {
      await signInAs('hr');

      const body = await (await fetchDocument(hrDocumentId)).text();

      expect(body).not.toContain(FIXTURE);
    });
  });

  describe('GET /api/documents/:id/original', () => {
    it('answers 401 without a session', async () => {
      const response = await fetchOriginal(hrDocumentId);

      expect(response.status).toBe(401);
    });

    it('serves the DOCX under the slug of the document', async () => {
      await signInAs('hr');

      const response = await fetchOriginal(hrDocumentId);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="hr-pto-policy.docx"',
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(await readFile(FIXTURE))).toBe(true);
    });

    it('answers 403 to another role and sends no file', async () => {
      await signInAs('sales');

      const response = await fetchOriginal(hrDocumentId);

      expect(response.status).toBe(403);
      expect(response.headers.get('content-disposition')).toBeNull();
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
    });

    it('answers 404 to an unknown id and to one that is not a uuid', async () => {
      await signInAs('admin');

      expect((await fetchOriginal(randomUUID())).status).toBe(404);
      expect((await fetchOriginal('not-a-uuid')).status).toBe(404);
    });
  });
});
