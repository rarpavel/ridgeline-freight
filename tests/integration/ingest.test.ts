import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { chunks } from '@/server/db/schema/chunks';
import { documents } from '@/server/db/schema/documents';
import { ingestCorpus, type IngestDeps } from '@/server/ingest/pipeline';
import { embedTexts } from '@/server/llm/embeddings';

import { catalogSchema, type CatalogEntry } from '../../data-gen/schemas/catalog';
import { renderDocx } from '../../scripts/data-gen/markdown-docx';
import { createDatabase, dropDatabase } from './helpers/database';

vi.mock('server-only', () => ({}));
vi.mock('@/env', () => ({
  env: {
    OPENAI_API_KEY: 'unused-fake-embedder',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    EMBEDDING_MODEL: 'fake-embedding',
    NEXT_PUBLIC_APP_ENV: 'local',
  },
}));

const run = promisify(execFile);

const DB_NAME = `ridgeline_ingest_${process.pid}`;
const MODEL = 'fake-embedding';
const DIMENSIONS = 1536;

function fakeVector(text: string): number[] {
  const digest = createHash('sha256').update(text).digest();
  return Array.from(
    { length: DIMENSIONS },
    (_, index) => (digest[index % digest.length] ?? 0) / 255,
  );
}

function clause(section: number, index: number, topic: string): string {
  const sentence = `The ${topic} obligation number ${index} applies to every shipment under this section. `;
  return `${section}.${index} ${sentence.repeat(9)}`;
}

function markdown(title: string, topic: string, clausesPerSection = 2, sections = 2): string {
  const parts = [`# ${title}`];
  for (let section = 1; section <= sections; section += 1) {
    parts.push(`## ${section}. ${topic} terms`);
    for (let index = 1; index <= clausesPerSection; index += 1) {
      parts.push(clause(section, index, topic));
    }
  }
  return parts.join('\n\n');
}

const ENTRIES: CatalogEntry[] = [
  { slug: 'msa-alpha', title: 'MSA Alpha', type: 'msa', roles: ['sales', 'admin'] },
  { slug: 'hr-beta', title: 'HR Beta', type: 'hr_policy', roles: ['hr', 'admin'] },
  { slug: 'sop-gamma', title: 'SOP Gamma', type: 'sop', roles: ['ops', 'admin'] },
];

describe('ingest pipeline', () => {
  let url: string;
  let pool: Pool;
  let client: Client;
  let corpusDir: string;
  let deps: IngestDeps;
  let embedded: string[][];

  async function writeDocument(entry: CatalogEntry, content: string): Promise<void> {
    const dir = path.join(corpusDir, entry.type);
    await mkdir(dir, { recursive: true });
    const docx = await renderDocx(content, { companyName: 'Fixture', documentId: entry.slug });
    await writeFile(path.join(dir, `${entry.slug}.docx`), docx);
  }

  function count(table: string): Promise<number> {
    return client
      .query<{ count: string }>(`SELECT count(*) FROM ${table}`)
      .then(({ rows }) => Number(rows[0]?.count));
  }

  async function chunkIds(slug: string): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>(
      'SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.slug = $1 ORDER BY c.ordinal',
      [slug],
    );
    return rows.map(({ id }) => id);
  }

  beforeAll(async () => {
    await dropDatabase(DB_NAME);
    url = await createDatabase(DB_NAME);
    await run('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_URL_DIRECT: url } });
    pool = new Pool({ connectionString: url });
    client = new Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await pool.end();
    await dropDatabase(DB_NAME);
  });

  beforeEach(async () => {
    await client.query('TRUNCATE documents CASCADE');
    corpusDir = await mkdtemp(path.join(tmpdir(), 'ridgeline-ingest-'));
    for (const entry of ENTRIES) await writeDocument(entry, markdown(entry.title, entry.slug));
    embedded = [];
    deps = {
      db: drizzle(pool, { schema: { documents, chunks } }) as unknown as IngestDeps['db'],
      embed: async (texts) => {
        embedded.push(texts);
        return texts.map(fakeVector);
      },
      embeddingModel: MODEL,
      corpusDir,
    };
    return () => rm(corpusDir, { recursive: true, force: true });
  });

  it('writes documents, texts and chunks with embeddings and the model name', async () => {
    const rows = await ingestCorpus(ENTRIES, {}, deps);

    expect(rows.map(({ status }) => status)).toEqual(['embedded', 'embedded', 'embedded']);
    expect(await count('documents')).toBe(3);
    expect(await count('document_texts')).toBe(3);

    const stored = await client.query<{
      content: string;
      text: string;
      char_start: number;
      char_end: number;
      embedding_model: string;
      tsv: string | null;
      has_embedding: boolean;
    }>(
      `SELECT c.content, t.text, c.char_start, c.char_end, c.embedding_model, c.tsv::text AS tsv,
              c.embedding IS NOT NULL AS has_embedding
       FROM chunks c JOIN document_texts t ON t.document_id = c.document_id`,
    );
    expect(stored.rows.length).toBe(rows.reduce((sum, row) => sum + row.chunks, 0));
    expect(stored.rows.length).toBeGreaterThanOrEqual(3);
    for (const row of stored.rows) {
      expect(row.embedding_model).toBe(MODEL);
      expect(row.has_embedding).toBe(true);
      expect(row.tsv).toBeTruthy();
      expect(row.text.slice(row.char_start, row.char_end)).toBe(row.content);
    }

    const roles = await client.query<{ access_roles: string[]; doc_type: string }>(
      "SELECT access_roles, doc_type FROM documents WHERE slug = 'hr-beta'",
    );
    expect(roles.rows[0]).toEqual({ access_roles: ['hr', 'admin'], doc_type: 'hr_policy' });
  });

  it('embeds the context prefix together with the content', async () => {
    await ingestCorpus(ENTRIES, { only: 'msa-alpha' }, deps);

    const { rows } = await client.query<{ context_prefix: string; content: string }>(
      'SELECT context_prefix, content FROM chunks ORDER BY ordinal',
    );
    expect(embedded.flat()).toEqual(rows.map((row) => `${row.context_prefix}\n${row.content}`));
  });

  it('skips every unchanged document on a second run', async () => {
    await ingestCorpus(ENTRIES, {}, deps);
    const before = await chunkIds('msa-alpha');
    embedded = [];

    const rows = await ingestCorpus(ENTRIES, {}, deps);

    expect(rows.map(({ status }) => status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(embedded).toEqual([]);
    expect(await chunkIds('msa-alpha')).toEqual(before);
  });

  it('rewrites every document with force', async () => {
    await ingestCorpus(ENTRIES, {}, deps);
    const before = await chunkIds('msa-alpha');
    const total = await count('chunks');
    embedded = [];

    const rows = await ingestCorpus(ENTRIES, { force: true }, deps);

    expect(rows.map(({ status }) => status)).toEqual(['embedded', 'embedded', 'embedded']);
    expect(embedded).toHaveLength(3);
    expect(await count('documents')).toBe(3);
    expect(await count('chunks')).toBe(total);
    const after = await chunkIds('msa-alpha');
    expect(after.some((id) => before.includes(id))).toBe(false);
  });

  it('rewrites only the changed document and removes its old chunks', async () => {
    await ingestCorpus(ENTRIES, {}, deps);
    const untouched = await chunkIds('hr-beta');
    const old = await chunkIds('msa-alpha');
    const alpha = ENTRIES[0] as CatalogEntry;
    await writeDocument(alpha, markdown(alpha.title, 'revised', 3, 3));

    const rows = await ingestCorpus(ENTRIES, {}, deps);

    expect(rows.map(({ status }) => status)).toEqual(['embedded', 'skipped', 'skipped']);
    expect(await chunkIds('hr-beta')).toEqual(untouched);
    const current = await chunkIds('msa-alpha');
    expect(current.some((id) => old.includes(id))).toBe(false);
    const { rows: leftovers } = await client.query(
      'SELECT 1 FROM chunks WHERE id = ANY($1::uuid[])',
      [old],
    );
    expect(leftovers).toHaveLength(0);
    const { rows: text } = await client.query<{ text: string }>(
      "SELECT t.text FROM document_texts t JOIN documents d ON d.id = t.document_id WHERE d.slug = 'msa-alpha'",
    );
    expect(text[0]?.text).toContain('revised');
  });

  it('re-ingests a document written by another chunker version', async () => {
    await ingestCorpus(ENTRIES, {}, deps);
    await client.query("UPDATE documents SET chunker_version = 'v0' WHERE slug = 'sop-gamma'");

    const rows = await ingestCorpus(ENTRIES, {}, deps);

    expect(rows.map(({ status }) => status)).toEqual(['skipped', 'skipped', 'embedded']);
  });

  it('limits the run with only and rejects an unknown slug', async () => {
    const rows = await ingestCorpus(ENTRIES, { only: 'hr-beta' }, deps);

    expect(rows.map(({ slug }) => slug)).toEqual(['hr-beta']);
    expect(await count('documents')).toBe(1);
    await expect(ingestCorpus(ENTRIES, { only: 'nope' }, deps)).rejects.toThrow('nope');
  });

  it('leaves no trace of a new document when its third embedding batch fails', async () => {
    const big: CatalogEntry = { slug: 'msa-big', title: 'MSA Big', type: 'msa', roles: ['sales'] };
    await writeDocument(big, markdown(big.title, 'volume', 15, 10));
    const batches: number[] = [];
    deps.embed = (texts) =>
      embedTexts(texts, async (batch) => {
        batches.push(batch.length);
        if (batches.length === 3) throw new Error('embedding service down');
        return batch.map(fakeVector);
      });

    const rows = await ingestCorpus([big], {}, deps);

    expect(batches).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      slug: 'msa-big',
      status: 'failed',
      error: 'embedding service down',
    });
    expect(await count('documents')).toBe(0);
    expect(await count('document_texts')).toBe(0);
    expect(await count('chunks')).toBe(0);
  });

  it('keeps the previous version when re-embedding fails and still processes the rest', async () => {
    await ingestCorpus(ENTRIES, {}, deps);
    const before = await chunkIds('msa-alpha');
    const alpha = ENTRIES[0] as CatalogEntry;
    await writeDocument(alpha, markdown(alpha.title, 'revised', 3, 3));
    const beta = ENTRIES[1] as CatalogEntry;
    await writeDocument(beta, markdown(beta.title, 'revised', 3, 3));
    deps.embed = async (texts) => {
      if (texts.some((text) => text.includes('MSA Alpha'))) throw new Error('boom');
      return texts.map(fakeVector);
    };

    const rows = await ingestCorpus(ENTRIES, {}, deps);

    expect(rows.map(({ status }) => status)).toEqual(['failed', 'embedded', 'skipped']);
    expect(await chunkIds('msa-alpha')).toEqual(before);
  });

  it('rolls the whole document back when a chunk insert fails', async () => {
    await ingestCorpus(ENTRIES, { only: 'msa-alpha' }, deps);
    const before = await chunkIds('msa-alpha');
    const alpha = ENTRIES[0] as CatalogEntry;
    await writeDocument(alpha, markdown(alpha.title, 'revised', 3, 3));
    await client.query(`
      CREATE FUNCTION fail_chunk_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'chunk insert failed'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_chunk_insert BEFORE INSERT ON chunks
        FOR EACH ROW EXECUTE FUNCTION fail_chunk_insert();
    `);

    try {
      const rows = await ingestCorpus(ENTRIES, { only: 'msa-alpha' }, deps);

      expect(rows[0]).toMatchObject({ status: 'failed', error: 'chunk insert failed' });
      expect(await chunkIds('msa-alpha')).toEqual(before);
      const { rows: text } = await client.query<{ text: string }>(
        'SELECT text FROM document_texts',
      );
      expect(text[0]?.text).not.toContain('revised');
    } finally {
      await client.query(`
        DROP TRIGGER fail_chunk_insert ON chunks;
        DROP FUNCTION fail_chunk_insert();
      `);
    }
  });

  it('rejects a second embedding model unless the whole corpus is forced', async () => {
    await ingestCorpus(ENTRIES, {}, deps);
    const other = { ...deps, embeddingModel: 'other-model' };

    await expect(ingestCorpus(ENTRIES, {}, other)).rejects.toThrow(MODEL);
    await expect(ingestCorpus(ENTRIES, { force: true, only: 'hr-beta' }, other)).rejects.toThrow(
      MODEL,
    );

    await ingestCorpus(ENTRIES, { force: true }, other);
    const { rows } = await client.query('SELECT DISTINCT embedding_model FROM chunks');
    expect(rows).toEqual([{ embedding_model: 'other-model' }]);
  });
});

describe('pnpm ingest', () => {
  const CLI_DB_NAME = `${DB_NAME}_cli`;
  let url: string;
  let client: Client;
  let server: Server;
  let requestCount = 0;
  let failOnRequest: number | undefined;

  function ingest(...args: string[]) {
    const { port } = server.address() as AddressInfo;
    return run('pnpm', ['--silent', 'ingest', ...args], {
      env: {
        ...process.env,
        DATABASE_URL: url,
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
        EMBEDDING_MODEL: MODEL,
        SESSION_SECRET: 'test-session-secret-at-least-32-chars',
        DEMO_ACCOUNTS_JSON: JSON.stringify([
          { id: 'sales', role: 'sales', passwordHash: `$2b$10$${'a'.repeat(53)}` },
        ]),
      },
    });
  }

  beforeAll(async () => {
    await dropDatabase(CLI_DB_NAME);
    url = await createDatabase(CLI_DB_NAME);
    await run('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_URL_DIRECT: url } });
    client = new Client({ connectionString: url });
    await client.connect();
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        requestCount += 1;
        res.setHeader('content-type', 'application/json');
        if (requestCount === failOnRequest) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'scripted failure' } }));
          return;
        }
        const { input } = JSON.parse(raw) as { input: string[] };
        const data = input.map((text, index) => ({ index, embedding: fakeVector(text) }));
        res.end(JSON.stringify({ data }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await client.end();
    await new Promise((resolve) => server.close(resolve));
    await dropDatabase(CLI_DB_NAME);
  });

  it('exits 1 on a failure, recovers on the next run, then skips all 24 quickly', async () => {
    const catalog = catalogSchema.parse(JSON.parse(await readFile('data/catalog.json', 'utf8')));
    const third = catalog[2]?.slug;

    failOnRequest = 3;
    await expect(ingest()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`${third}: 400`),
    });
    const afterFailure = await client.query<{ slug: string }>('SELECT slug FROM documents');
    expect(afterFailure.rows).toHaveLength(23);
    expect(afterFailure.rows.map(({ slug }) => slug)).not.toContain(third);

    failOnRequest = undefined;
    await ingest();
    const counts = await client.query<{ documents: string; chunks: string; models: string[] }>(
      `SELECT (SELECT count(*) FROM documents) AS documents,
              (SELECT count(*) FROM chunks) AS chunks,
              (SELECT array_agg(DISTINCT embedding_model) FROM chunks) AS models`,
    );
    expect(Number(counts.rows[0]?.documents)).toBe(24);
    expect(Number(counts.rows[0]?.chunks)).toBeGreaterThan(0);
    expect(counts.rows[0]?.models).toEqual([MODEL]);

    requestCount = 0;
    const started = Date.now();
    const { stdout } = await ingest();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(requestCount).toBe(0);
    // Columns: embedded, skipped, failed.
    expect(stdout.match(/false\s*│\s*true\s*│\s*false/g)).toHaveLength(24);
  });

  it('exits 1 on an unknown slug or flag', async () => {
    await expect(ingest('--only', 'nope')).rejects.toMatchObject({ code: 1 });
    await expect(ingest('--nope')).rejects.toMatchObject({ code: 1 });
  });
});
