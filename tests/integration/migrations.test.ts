import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { chunks } from '@/server/db/schema/chunks';
import { documents, documentTexts } from '@/server/db/schema/documents';
import { evalQuestions, evalResults, evalRuns } from '@/server/db/schema/eval';
import { requestTraces } from '@/server/db/schema/request-traces';

import { createDatabase, dropDatabase, withClient } from './helpers/database';

vi.mock('server-only', () => ({}));

const run = promisify(execFile);

const DB_NAME = `ridgeline_migrations_${process.pid}`;
const FALLBACK_DB_NAME = `${DB_NAME}_fallback`;

const EMBEDDING = `[${new Array(1536).fill(0.1).join(',')}]`;

function migrate(env: Record<string, string>) {
  return run('pnpm', ['db:migrate'], { env: { ...process.env, ...env } });
}

async function columnsOf(client: Client, table: string): Promise<string[]> {
  const { rows } = await client.query<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
    [table],
  );
  return rows.map((row) => row.column_name).sort();
}

function drizzleColumnsOf(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table)
    .columns.map((column) => column.name)
    .sort();
}

describe('migrations', () => {
  let url: string;
  let client: Client;
  let slugCounter = 0;

  function insertDocument(overrides: { docType?: string; accessRoles?: string[] } = {}) {
    slugCounter += 1;
    return client.query<{ id: string }>(
      `INSERT INTO documents (slug, title, doc_type, access_roles, source_path, checksum, chunker_version)
       VALUES ($1, 'Title', $2, $3, $4, 'checksum', 'v1') RETURNING id`,
      [
        `doc-${slugCounter}`,
        overrides.docType ?? 'msa',
        overrides.accessRoles ?? ['sales'],
        `data/corpus/doc-${slugCounter}.docx`,
      ],
    );
  }

  function insertChunk(
    documentId: string,
    ordinal: number,
    overrides: { charStart?: number; charEnd?: number; tokenCount?: number } = {},
  ) {
    return client.query<{ tsv: string }>(
      `INSERT INTO chunks (document_id, ordinal, context_prefix, content, char_start, char_end,
                           token_count, embedding, embedding_model)
       VALUES ($1, $2, 'Harbor Point MSA', 'Late delivery penalties apply', $3, $4, $5, $6,
               'text-embedding-3-small')
       RETURNING tsv`,
      [
        documentId,
        ordinal,
        overrides.charStart ?? 0,
        overrides.charEnd ?? 10,
        overrides.tokenCount ?? 5,
        EMBEDDING,
      ],
    );
  }

  beforeAll(async () => {
    await dropDatabase(DB_NAME);
    url = await createDatabase(DB_NAME);
    await migrate({ DATABASE_URL_DIRECT: url });
    client = new Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await dropDatabase(DB_NAME);
  });

  it('creates the vector extension and only the expected tables', async () => {
    const extension = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    expect(extension.rowCount).toBe(1);

    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual([
      'chunks',
      'document_texts',
      'documents',
      'eval_questions',
      'eval_results',
      'eval_runs',
      'request_traces',
    ]);
  });

  it('gives chunks the DATA_MODEL columns with the expected types', async () => {
    const { rows } = await client.query<{
      column_name: string;
      type: string;
      is_nullable: string;
    }>(
      `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type,
              CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable
       FROM pg_attribute a
       WHERE a.attrelid = 'chunks'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
    );

    expect(rows).toEqual([
      { column_name: 'id', type: 'uuid', is_nullable: 'NO' },
      { column_name: 'document_id', type: 'uuid', is_nullable: 'NO' },
      { column_name: 'ordinal', type: 'integer', is_nullable: 'NO' },
      { column_name: 'section_ref', type: 'text', is_nullable: 'YES' },
      { column_name: 'section_title', type: 'text', is_nullable: 'YES' },
      { column_name: 'context_prefix', type: 'text', is_nullable: 'NO' },
      { column_name: 'content', type: 'text', is_nullable: 'NO' },
      { column_name: 'char_start', type: 'integer', is_nullable: 'NO' },
      { column_name: 'char_end', type: 'integer', is_nullable: 'NO' },
      { column_name: 'token_count', type: 'integer', is_nullable: 'NO' },
      { column_name: 'embedding', type: 'vector(1536)', is_nullable: 'NO' },
      { column_name: 'embedding_model', type: 'text', is_nullable: 'NO' },
      { column_name: 'tsv', type: 'tsvector', is_nullable: 'YES' },
    ]);
  });

  it('generates tsv from context_prefix and content, with a GIN index and no vector index', async () => {
    const generated = await client.query<{ is_generated: string }>(
      `SELECT is_generated FROM information_schema.columns
       WHERE table_name = 'chunks' AND column_name = 'tsv'`,
    );
    expect(generated.rows[0]?.is_generated).toBe('ALWAYS');

    const { rows: indexes } = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'chunks'`,
    );
    const tsvIndex = indexes.find((index) => index.indexname === 'chunks_tsv_idx');
    expect(tsvIndex?.indexdef).toContain('USING gin (tsv)');
    expect(indexes.map((index) => index.indexname)).toContain('chunks_document_idx');
    expect(indexes.filter((index) => index.indexdef.includes('embedding'))).toEqual([]);

    const document = await insertDocument();
    const documentId = document.rows[0]?.id ?? '';
    const chunk = await insertChunk(documentId, 0);
    expect(chunk.rows[0]?.tsv).toContain("'harbor'");
    expect(chunk.rows[0]?.tsv).toContain("'penalti'");
  });

  it('rejects an unknown doc_type', async () => {
    await expect(insertDocument({ docType: 'x' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'documents_doc_type_check',
    });
  });

  it('rejects unknown and empty access_roles on documents', async () => {
    await expect(insertDocument({ accessRoles: ['sales', 'finance'] })).rejects.toMatchObject({
      code: '23514',
      constraint: 'documents_access_roles_check',
    });
    await expect(insertDocument({ accessRoles: [] })).rejects.toMatchObject({
      code: '23514',
      constraint: 'documents_access_roles_check',
    });
  });

  it('rejects access_roles on a chunk, which inherits roles from its document', async () => {
    const document = await insertDocument();
    await expect(
      client.query(
        `INSERT INTO chunks (document_id, ordinal, context_prefix, content, char_start, char_end,
                             token_count, embedding, embedding_model, access_roles)
         VALUES ($1, 0, 'p', 'c', 0, 1, 1, $2, 'm', ARRAY['finance'])`,
        [document.rows[0]?.id, EMBEDDING],
      ),
    ).rejects.toMatchObject({ code: '42703' });
  });

  it('rejects chunks with an empty char range or no tokens', async () => {
    const document = await insertDocument();
    const documentId = document.rows[0]?.id ?? '';

    await expect(insertChunk(documentId, 0, { charStart: 5, charEnd: 5 })).rejects.toMatchObject({
      code: '23514',
      constraint: 'chunks_char_range_check',
    });
    await expect(insertChunk(documentId, 1, { tokenCount: 0 })).rejects.toMatchObject({
      code: '23514',
      constraint: 'chunks_token_count_check',
    });
  });

  it('rejects a duplicate ordinal within a document and cascades deletes', async () => {
    const document = await insertDocument();
    const documentId = document.rows[0]?.id ?? '';
    await insertChunk(documentId, 0);

    await expect(insertChunk(documentId, 0)).rejects.toMatchObject({ code: '23505' });

    await client.query('DELETE FROM documents WHERE id = $1', [documentId]);
    const remaining = await client.query('SELECT 1 FROM chunks WHERE document_id = $1', [
      documentId,
    ]);
    expect(remaining.rowCount).toBe(0);
  });

  it('rejects an unknown source, gate or refusal_reason on a trace', async () => {
    const insertTrace = (source: string, gate: string, refusalReason: string | null) =>
      client.query(
        `INSERT INTO request_traces (source, account, role, question, retrieval, gate, refusal_reason)
         VALUES ($1, 'sales', 'sales', 'q', '{}', $2, $3)`,
        [source, gate, refusalReason],
      );

    await expect(insertTrace('chat', 'refuse_gate', 'gate')).resolves.toBeDefined();
    await expect(insertTrace('cron', 'answer', null)).rejects.toMatchObject({
      code: '23514',
      constraint: 'request_traces_source_check',
    });
    await expect(insertTrace('chat', 'refuse', null)).rejects.toMatchObject({
      code: '23514',
      constraint: 'request_traces_gate_check',
    });
    await expect(insertTrace('chat', 'answer', 'other')).rejects.toMatchObject({
      code: '23514',
      constraint: 'request_traces_refusal_reason_check',
    });
  });

  it('indexes request_traces by created_at, newest first', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'request_traces_created_idx'`,
    );
    expect(rows[0]?.indexdef).toContain('created_at DESC');
  });

  it('rejects an unknown category, split or role on an eval question', async () => {
    let counter = 0;
    const insertQuestion = (category: string, split: string, role: string) => {
      counter += 1;
      return client.query(
        `INSERT INTO eval_questions (slug, category, split, role, question, dataset_version)
         VALUES ($1, $2, $3, $4, 'q', '2026.11-1')`,
        [`question-${counter}`, category, split, role],
      );
    };

    await expect(insertQuestion('direct', 'dev', 'sales')).resolves.toBeDefined();
    await expect(insertQuestion('other', 'dev', 'sales')).rejects.toMatchObject({
      code: '23514',
      constraint: 'eval_questions_category_check',
    });
    await expect(insertQuestion('direct', 'all', 'sales')).rejects.toMatchObject({
      code: '23514',
      constraint: 'eval_questions_split_check',
    });
    await expect(insertQuestion('direct', 'dev', 'finance')).rejects.toMatchObject({
      code: '23514',
      constraint: 'eval_questions_role_check',
    });
  });

  it('accepts all as an eval run split, rejects an unknown one and cascades deletes', async () => {
    const insertRun = (split: string) =>
      client.query<{ id: string }>(
        `INSERT INTO eval_runs (split, model, embedding_model, prompt_version, retrieval_config,
                                git_sha, dataset_version)
         VALUES ($1, 'm', 'e', 'rag-system@v1#a1b2c3d4', '{}', 'sha', '2026.11-1') RETURNING id`,
        [split],
      );

    await expect(insertRun('other')).rejects.toMatchObject({
      code: '23514',
      constraint: 'eval_runs_split_check',
    });

    const run = await insertRun('all');
    const runId = run.rows[0]?.id;
    const question = await client.query<{ id: string }>(
      `INSERT INTO eval_questions (slug, category, split, role, question, dataset_version)
       VALUES ('cascade-question', 'direct', 'dev', 'sales', 'q', '2026.11-1') RETURNING id`,
    );
    await client.query(
      `INSERT INTO eval_results (run_id, question_id, answer, refused, retrieved, scores, latency_ms)
       VALUES ($1, $2, 'a', false, '[]', '{}', 1)`,
      [runId, question.rows[0]?.id],
    );

    await client.query('DELETE FROM eval_runs WHERE id = $1', [runId]);
    const remaining = await client.query('SELECT 1 FROM eval_results WHERE run_id = $1', [runId]);
    expect(remaining.rowCount).toBe(0);
  });

  it('changes nothing and exits 0 when run a second time', async () => {
    const applied = () => client.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id');
    const before = await applied();
    expect(before.rowCount).toBeGreaterThan(0);

    await expect(migrate({ DATABASE_URL_DIRECT: url })).resolves.toBeDefined();

    expect((await applied()).rows).toEqual(before.rows);
  });

  it('falls back to DATABASE_URL when DATABASE_URL_DIRECT is empty', async () => {
    await dropDatabase(FALLBACK_DB_NAME);
    const fallbackUrl = await createDatabase(FALLBACK_DB_NAME);
    try {
      await migrate({ DATABASE_URL_DIRECT: '', DATABASE_URL: fallbackUrl });
      await withClient(fallbackUrl, async (fallback) => {
        expect(await columnsOf(fallback, 'documents')).not.toEqual([]);
      });
    } finally {
      await dropDatabase(FALLBACK_DB_NAME);
    }
  });

  it('matches the Drizzle schema', async () => {
    expect(await columnsOf(client, 'documents')).toEqual(drizzleColumnsOf(documents));
    expect(await columnsOf(client, 'document_texts')).toEqual(drizzleColumnsOf(documentTexts));
    expect(await columnsOf(client, 'request_traces')).toEqual(drizzleColumnsOf(requestTraces));
    expect(await columnsOf(client, 'eval_questions')).toEqual(drizzleColumnsOf(evalQuestions));
    expect(await columnsOf(client, 'eval_runs')).toEqual(drizzleColumnsOf(evalRuns));
    expect(await columnsOf(client, 'eval_results')).toEqual(drizzleColumnsOf(evalResults));
    // tsv is added by a custom migration and is read through SQL, never written.
    expect(await columnsOf(client, 'chunks')).toEqual([...drizzleColumnsOf(chunks), 'tsv'].sort());
  });

  it('passes drizzle-kit check and has no ungenerated schema changes', async () => {
    // drizzle-kit can print an error and still exit 0, so these assert on its output.
    const check = await run('pnpm', ['exec', 'drizzle-kit', 'check']);
    expect(check.stdout).toContain("Everything's fine");

    // Generating into a copy keeps the working tree clean if the schema has drifted.
    const copy = await mkdtemp(join(tmpdir(), 'ridgeline-drizzle-'));
    try {
      await cp('drizzle', copy, { recursive: true });
      const { stdout } = await run('pnpm', [
        'exec',
        'drizzle-kit',
        'generate',
        '--dialect=postgresql',
        '--schema=src/server/db/schema',
        // drizzle-kit prefixes --out with "./", so an absolute path does not work.
        `--out=${relative(process.cwd(), copy)}`,
      ]);
      expect(stdout).toContain('No schema changes');
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('connects through the db client using DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-chars');
    vi.stubEnv(
      'DEMO_ACCOUNTS_JSON',
      JSON.stringify([{ id: 'sales', role: 'sales', passwordHash: `$2b$10$${'a'.repeat(53)}` }]),
    );
    try {
      const { db, pool } = await import('@/server/db/client');
      try {
        const rows = await db.select({ id: documents.id }).from(documents).limit(1);
        expect(Array.isArray(rows)).toBe(true);
      } finally {
        await pool.end();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
