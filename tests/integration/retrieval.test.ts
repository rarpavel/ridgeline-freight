import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/lib/errors';
import { chunks } from '@/server/db/schema/chunks';
import { documents } from '@/server/db/schema/documents';
import {
  loadPromptChunks,
  retrieve,
  retrieveCandidates,
  type RetrieveDeps,
} from '@/server/rag/retrieve';

import { createDatabase, dropDatabase } from './helpers/database';

vi.mock('server-only', () => ({}));

const run = promisify(execFile);

const DB_NAME = `ridgeline_retrieval_${process.pid}`;
const DIMENSIONS = 1536;
const ROLES = ['sales', 'hr', 'ops', 'admin'] as const;

// A unit vector along one axis: cosine similarity is 1 to itself and 0 to any other axis.
function axis(index: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, i) => (i === index ? 1 : 0));
}

type Fixture = {
  slug: string;
  docType: string;
  roles: string[];
  contents: string[];
};

const SOP_CHUNKS = 25;

const FIXTURES: Fixture[] = [
  {
    slug: 'msa-alpha',
    docType: 'msa',
    roles: ['sales', 'admin'],
    contents: [
      'Fixture policy: late delivery penalties for shipments.',
      'Fixture policy: payment.',
    ],
  },
  {
    slug: 'hr-pto',
    docType: 'hr_policy',
    roles: ['hr', 'admin'],
    contents: ['Fixture policy: PTO accrual is 15 days a year.', 'Fixture policy: parental leave.'],
  },
  {
    slug: 'sop-dock',
    docType: 'sop',
    roles: ['ops', 'admin'],
    contents: Array.from({ length: SOP_CHUNKS }, (_, i) => `Fixture policy: dock step ${i}.`),
  },
  {
    slug: 'rates-west',
    docType: 'rate_sheet',
    roles: ['sales', 'ops', 'admin'],
    contents: ['Fixture policy: western lane rates.'],
  },
];

const HR_PTO_AXIS = 2;

describe('retrieval', () => {
  let url: string;
  let pool: Pool;
  let db: RetrieveDeps['db'];
  const typeByDocument = new Map<string, string>();
  const slugByDocument = new Map<string, string>();

  const allowedSlugs = (role: string): string[] =>
    FIXTURES.filter(({ roles }) => roles.includes(role))
      .map(({ slug }) => slug)
      .sort();

  const slugsOf = (hits: { documentId: string }[]): string[] =>
    [...new Set(hits.map(({ documentId }) => slugByDocument.get(documentId) ?? ''))].sort();

  beforeAll(async () => {
    await dropDatabase(DB_NAME);
    url = await createDatabase(DB_NAME);
    await run('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_URL_DIRECT: url } });
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema: { documents, chunks } }) as unknown as RetrieveDeps['db'];

    let nextAxis = 0;
    for (const fixture of FIXTURES) {
      const [document] = await db
        .insert(documents)
        .values({
          slug: fixture.slug,
          title: fixture.slug,
          docType: fixture.docType,
          accessRoles: fixture.roles,
          sourcePath: `data/corpus/${fixture.slug}.docx`,
          checksum: fixture.slug,
          chunkerVersion: 'test',
        })
        .returning({ id: documents.id });
      if (!document) throw new Error(`No document for ${fixture.slug}`);
      typeByDocument.set(document.id, fixture.docType);
      slugByDocument.set(document.id, fixture.slug);

      await db.insert(chunks).values(
        fixture.contents.map((content, ordinal) => {
          nextAxis += 1;
          return {
            documentId: document.id,
            ordinal,
            contextPrefix: fixture.slug,
            content,
            charStart: 0,
            charEnd: content.length,
            tokenCount: 10,
            embedding: axis(nextAxis - 1),
            embeddingModel: 'fake-embedding',
          };
        }),
      );
    }
  });

  afterAll(async () => {
    await pool.end();
    await dropDatabase(DB_NAME);
  });

  describe('retrieveCandidates', () => {
    it.each(ROLES)('returns only documents open to %s from both queries', async (role) => {
      const { vector, fts } = await retrieveCandidates(
        { questionEmbedding: axis(HR_PTO_AXIS), question: 'fixture policy', roles: [role] },
        { db },
      );

      expect(vector.length).toBeGreaterThan(0);
      expect(fts.length).toBeGreaterThan(0);
      expect(slugsOf(vector).every((slug) => allowedSlugs(role).includes(slug))).toBe(true);
      expect(slugsOf(fts).every((slug) => allowedSlugs(role).includes(slug))).toBe(true);
    });

    it('computes sim as 1 - cosine distance, nearest first', async () => {
      const { vector } = await retrieveCandidates(
        { questionEmbedding: axis(HR_PTO_AXIS), question: 'pto', roles: ['hr'] },
        { db },
      );

      expect(slugByDocument.get(vector[0]?.documentId ?? '')).toBe('hr-pto');
      expect(vector[0]?.sim).toBeCloseTo(1);
      expect(vector[1]?.sim).toBeCloseTo(0);
    });

    it('returns numeric FTS scores, best first', async () => {
      const { fts } = await retrieveCandidates(
        { questionEmbedding: axis(0), question: 'PTO accrual', roles: ['hr'] },
        { db },
      );

      expect(slugsOf(fts)).toEqual(['hr-pto']);
      expect(typeof fts[0]?.score).toBe('number');
      expect(fts[0]?.score).toBeGreaterThan(0);
    });

    it('caps each query at 20 rows', async () => {
      const { vector, fts } = await retrieveCandidates(
        { questionEmbedding: axis(0), question: 'dock step', roles: ['ops'] },
        { db },
      );

      expect(vector).toHaveLength(20);
      expect(fts).toHaveLength(20);
    });

    it('treats no FTS match as a normal result', async () => {
      const { vector, fts, vectorUnavailable } = await retrieveCandidates(
        { questionEmbedding: axis(0), question: 'quantum entanglement', roles: ['sales'] },
        { db },
      );

      expect(fts).toEqual([]);
      expect(vector.length).toBeGreaterThan(0);
      expect(vectorUnavailable).toBe(false);
    });

    it.each(['"unbalanced OR -', 'the and of', ''])(
      'accepts the odd question %j',
      async (question) => {
        const { fts } = await retrieveCandidates(
          { questionEmbedding: axis(0), question, roles: ['sales'] },
          { db },
        );

        expect(fts).toEqual([]);
      },
    );

    it('returns nothing for no roles', async () => {
      const { vector, fts } = await retrieveCandidates(
        { questionEmbedding: axis(0), question: 'fixture policy', roles: [] },
        { db },
      );

      expect(vector).toEqual([]);
      expect(fts).toEqual([]);
    });

    it('skips the vector query without an embedding', async () => {
      const { vector, fts, vectorUnavailable } = await retrieveCandidates(
        { questionEmbedding: null, question: 'fixture policy', roles: ['sales'] },
        { db },
      );

      expect(vector).toEqual([]);
      expect(fts.length).toBeGreaterThan(0);
      expect(vectorUnavailable).toBe(true);
    });

    it('reports a failed query as db_error without the vector in the message', async () => {
      const failure = await retrieveCandidates(
        { questionEmbedding: [0.123456, 0.654321], question: 'fixture', roles: ['sales'] },
        { db },
      ).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).code).toBe('db_error');
      expect((failure as AppError).message).not.toContain('0.123456');
      expect(String((failure as AppError).cause)).not.toContain('0.123456');
    });
  });

  describe('retrieve', () => {
    const embedAs = (index: number) => async (texts: string[]) => texts.map(() => axis(index));

    it('gives sales no hr_policy document for a PTO question that hr gets', async () => {
      const question = 'How many PTO days do I accrue?';
      const embed = embedAs(HR_PTO_AXIS);

      const sales = await retrieve({ question, roles: ['sales'] }, { db, embed });
      const hr = await retrieve({ question: 'PTO accrual', roles: ['hr'] }, { db, embed });

      expect(sales.candidates.length).toBeGreaterThan(0);
      expect(
        sales.candidates.filter(({ documentId }) => typeByDocument.get(documentId) === 'hr_policy'),
      ).toEqual([]);
      expect(sales.ftsMatches).toBe(0);

      expect(typeByDocument.get(hr.candidates[0]?.documentId ?? '')).toBe('hr_policy');
      expect(hr.bestSim).toBeCloseTo(1);
    });

    it('falls back to FTS when the embedder fails', async () => {
      const failing = vi.fn().mockRejectedValue(new Error('embedder down'));

      const result = await retrieve(
        { question: 'fixture policy', roles: ['sales'] },
        { db, embed: failing },
      );

      expect(failing).toHaveBeenCalledOnce();
      expect(result.vectorUnavailable).toBe(true);
      expect(result.bestSim).toBeNull();
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates.every(({ vectorRank }) => vectorRank === null)).toBe(true);
      expect(slugsOf(result.candidates)).toEqual(['msa-alpha', 'rates-west']);
    });

    it('returns no candidates when the embedder fails and FTS finds nothing', async () => {
      const result = await retrieve(
        { question: 'quantum entanglement', roles: ['sales'] },
        { db, embed: vi.fn().mockRejectedValue(new Error('embedder down')) },
      );

      expect(result).toEqual({
        candidates: [],
        bestSim: null,
        ftsMatches: 0,
        vectorUnavailable: true,
      });
    });

    it('fuses both lists and applies the per-document cap', async () => {
      const result = await retrieve(
        { question: 'fixture policy', roles: ['admin'] },
        { db, embed: embedAs(HR_PTO_AXIS) },
      );
      const inPrompt = result.candidates.filter((candidate) => candidate.inPrompt);
      const perDocument = new Map<string, number>();
      for (const { documentId } of inPrompt) {
        perDocument.set(documentId, (perDocument.get(documentId) ?? 0) + 1);
      }

      expect(inPrompt.length).toBeLessThanOrEqual(8);
      expect(Math.max(...perDocument.values())).toBeLessThanOrEqual(3);
      expect(result.ftsMatches).toBe(20);
      expect(result.vectorUnavailable).toBe(false);
      expect(result.candidates.some((c) => c.vectorRank !== null && c.ftsRank !== null)).toBe(true);
    });
  });

  describe('loadPromptChunks', () => {
    const hitsFor = async (question: string) => {
      const { fts } = await retrieveCandidates(
        { questionEmbedding: null, question, roles: ['admin'] },
        { db },
      );
      return fts.map(({ chunkId }) => chunkId);
    };

    it('returns the chunks in the order asked for, with their document title', async () => {
      const chunkIds = (await hitsFor('fixture policy')).slice(0, 5).reverse();

      const loaded = await loadPromptChunks({ chunkIds, roles: ['admin'] }, { db });

      expect(loaded.map(({ chunkId }) => chunkId)).toEqual(chunkIds);
      expect(loaded.every(({ documentTitle }) => documentTitle.length > 0)).toBe(true);
      expect(loaded.every(({ content }) => content.startsWith('Fixture policy'))).toBe(true);
    });

    it('applies the role filter even to a chunk id it is handed', async () => {
      const chunkIds = await hitsFor('PTO accrual');
      expect(chunkIds.length).toBeGreaterThan(0);

      const forSales = await loadPromptChunks({ chunkIds, roles: ['sales'] }, { db });
      const forHr = await loadPromptChunks({ chunkIds, roles: ['hr'] }, { db });

      expect(forSales).toEqual([]);
      expect(forHr.map(({ chunkId }) => chunkId)).toEqual(chunkIds);
    });

    it('skips an id that no longer exists and asks nothing for an empty list', async () => {
      const [known] = await hitsFor('PTO accrual');
      if (!known) throw new Error('No fixture chunk');
      const missing = '00000000-0000-4000-8000-000000000000';

      const loaded = await loadPromptChunks({ chunkIds: [missing, known], roles: ['hr'] }, { db });

      expect(loaded.map(({ chunkId }) => chunkId)).toEqual([known]);
      expect(await loadPromptChunks({ chunkIds: [], roles: ['hr'] }, { db })).toEqual([]);
    });
  });
});
