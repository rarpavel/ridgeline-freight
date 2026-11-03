import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { sealData } from 'iron-session';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { chunks } from '@/server/db/schema/chunks';

import { catalogSchema, ROLES, type CatalogEntry } from '../../data-gen/schemas/catalog';
import { evalQuestionsSchema, type EvalQuestion } from '../../data-gen/schemas/questions';
import { createDatabase, dropDatabase } from './helpers/database';
import { fakeVector } from './helpers/fake-embedding';

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

const DB_NAME = `ridgeline_rbac_leak_${process.pid}`;
const SECRET = 'test-session-secret-at-least-32-chars';
const HASH = `$2b$10$${'a'.repeat(53)}`;
const MODEL = 'fake-embedding';

type Role = (typeof ROLES)[number];
type Violation = { role: Role; question: string; source: string; document: string };

const embed = async (text: string) => ({ embedding: fakeVector(text), tokens: 1 });

describe('rbac leak', () => {
  let catalog: CatalogEntry[];
  let questions: EvalQuestion[];
  let retrieval: typeof import('@/server/rag/retrieve');
  let getDocument: typeof import('@/app/api/documents/[id]/route').GET;
  let getOriginal: typeof import('@/app/api/documents/[id]/original/route').GET;
  let appDb: typeof import('@/server/db/client').db;
  let closeAppPool: () => Promise<unknown>;
  const idBySlug = new Map<string, string>();
  const chunkIdBySlug = new Map<string, string>();

  // From the catalog, not the database, so a wrong access_roles at ingest counts as a leak too.
  const canRead = (role: Role, slug: string) =>
    catalog.find((entry) => entry.slug === slug)?.roles.includes(role) === true;

  const search = (question: string, role: Role) =>
    retrieval.retrieve({ question, roles: [role] }, { db: appDb, embed });

  function reportViolations(violations: Violation[]) {
    if (violations.length > 0) console.table(violations);
    expect(violations).toEqual([]);
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

    retrieval = await import('@/server/rag/retrieve');
    ({ GET: getDocument } = await import('@/app/api/documents/[id]/route'));
    ({ GET: getOriginal } = await import('@/app/api/documents/[id]/original/route'));
    const client = await import('@/server/db/client');
    appDb = client.db;
    closeAppPool = () => client.pool.end();
    const { ingestCorpus } = await import('@/server/ingest/pipeline');

    catalog = catalogSchema.parse(JSON.parse(await readFile('data/catalog.json', 'utf8')));
    questions = evalQuestionsSchema.parse(
      JSON.parse(await readFile('data/eval/questions.json', 'utf8')),
    );

    const rows = await ingestCorpus(
      catalog,
      {},
      {
        db: appDb,
        embed: async (texts) => texts.map(fakeVector),
        embeddingModel: MODEL,
        corpusDir: 'data/corpus',
      },
    );
    expect(rows.filter(({ status }) => status !== 'embedded')).toEqual([]);

    const ingested = await appDb.query.documents.findMany({
      columns: { id: true, slug: true },
    });
    for (const { id, slug } of ingested) idBySlug.set(slug, id);
    const firstChunks = await appDb
      .selectDistinctOn([chunks.documentId], { id: chunks.id, documentId: chunks.documentId })
      .from(chunks);
    for (const { slug, id } of ingested) {
      const chunk = firstChunks.find(({ documentId }) => documentId === id);
      if (chunk) chunkIdBySlug.set(slug, chunk.id);
    }
  });

  afterAll(async () => {
    await closeAppPool();
    vi.unstubAllEnvs();
    await dropDatabase(DB_NAME);
  });

  it('indexes the whole demo corpus and every eval question', () => {
    expect(catalog).toHaveLength(24);
    expect(idBySlug.size).toBe(24);
    expect(chunkIdBySlug.size).toBe(24);
    expect(ROLES).toHaveLength(4);
    expect(questions).toHaveLength(44);
  });

  it('never retrieves a document outside the role, for each role and question', async () => {
    const violations: Violation[] = [];
    const slugById = new Map([...idBySlug].map(([slug, id]) => [id, slug]));
    let combinations = 0;

    for (const { question } of questions) {
      // Everything any role could reach, handed to each role below as if it had been retrieved.
      const { candidates: reachable } = await search(question, 'admin');
      const chunkIds = reachable.map(({ chunkId }) => chunkId);

      for (const role of ROLES) {
        combinations += 1;
        const { candidates, vectorUnavailable } = await search(question, role);
        const loaded = await retrieval.loadPromptChunks({ chunkIds, roles: [role] }, { db: appDb });

        // Every role can read something, so an empty result would mean a test that checks nothing.
        expect(candidates.length).toBeGreaterThan(0);
        expect(vectorUnavailable).toBe(false);

        const check = (source: string, slugs: string[]) => {
          for (const document of new Set(slugs)) {
            if (!canRead(role, document)) violations.push({ role, question, source, document });
          }
        };
        check(
          'vector',
          candidates.filter(({ vectorRank }) => vectorRank !== null).map(({ slug }) => slug),
        );
        check(
          'fts',
          candidates.filter(({ ftsRank }) => ftsRank !== null).map(({ slug }) => slug),
        );
        check(
          'prompt',
          loaded.map(({ documentId }) => slugById.get(documentId) ?? documentId),
        );
      }
    }

    expect(combinations).toBe(176);
    reportViolations(violations);
  });

  describe('other_role questions', () => {
    const otherRole = () => questions.filter(({ category }) => category === 'other_role');

    it('has the five questions, each about documents its role cannot read', () => {
      expect(otherRole()).toHaveLength(5);
      for (const { role, expectedDocSlugs } of otherRole()) {
        expect(expectedDocSlugs.length).toBeGreaterThan(0);
        expect(expectedDocSlugs.filter((slug) => canRead(role, slug))).toEqual([]);
      }
    });

    // Not zero chunks in all: the vector list returns the nearest allowed chunks for any question,
    // and the FTS list matches on any word (ADR-0019). Refusing is the job of the gate and the model.
    it('returns no chunk of the document asked about, only chunks the role may read', async () => {
      const violations: Violation[] = [];

      for (const { role, question, expectedDocSlugs } of otherRole()) {
        const { candidates } = await search(question, role);

        expect(candidates.length).toBeGreaterThan(0);
        for (const { slug } of candidates) {
          if (expectedDocSlugs.includes(slug) || !canRead(role, slug)) {
            violations.push({ role, question, source: 'candidates', document: slug });
          }
        }
      }

      reportViolations(violations);
    });

    it('finds the document asked about for admin, so the question can reach it', async () => {
      for (const { question, expectedDocSlugs } of otherRole()) {
        const { candidates } = await search(question, 'admin');

        expect(candidates.map(({ slug }) => slug)).toEqual(
          expect.arrayContaining(expectedDocSlugs),
        );
      }
    });
  });

  describe('document viewer', () => {
    async function signInAs(role: Role) {
      cookieJar.set(
        'ridgeline_session',
        await sealData({ account: role, role, issuedAt: Date.now() }, { password: SECRET }),
      );
    }

    function fetchDocument(id: string, chunkId: string) {
      return getDocument(
        new Request(`https://ridgeline.test/api/documents/${id}?chunk=${chunkId}`),
        {
          params: Promise.resolve({ id }),
        },
      );
    }

    function fetchOriginal(id: string) {
      return getOriginal(new Request(`https://ridgeline.test/api/documents/${id}/original`), {
        params: Promise.resolve({ id }),
      });
    }

    it('answers 200 only to the roles of each document, on both routes', async () => {
      const violations: Violation[] = [];
      let combinations = 0;

      for (const { slug, title } of catalog) {
        const id = idBySlug.get(slug) ?? '';
        const chunkId = chunkIdBySlug.get(slug) ?? '';

        for (const role of ROLES) {
          combinations += 1;
          await signInAs(role);
          const expected = canRead(role, slug) ? 200 : 403;

          const viewer = await fetchDocument(id, chunkId);
          const original = await fetchOriginal(id);
          const viewerBody = await viewer.text();

          if (viewer.status !== expected) {
            violations.push({
              role,
              question: `viewer answered ${viewer.status}`,
              source: 'viewer',
              document: slug,
            });
          }
          if (original.status !== expected) {
            violations.push({
              role,
              question: `original answered ${original.status}`,
              source: 'original',
              document: slug,
            });
          }
          if (expected === 403) {
            expect(viewerBody).not.toContain(title);
            expect(original.headers.get('content-disposition')).toBeNull();
          }
        }
      }

      expect(combinations).toBe(96);
      reportViolations(violations);
    });
  });
});
