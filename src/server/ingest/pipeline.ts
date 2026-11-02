import 'server-only';

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';

import { AppError } from '@/lib/errors';
import type { db as appDb } from '@/server/db/client';
import { chunks } from '@/server/db/schema/chunks';
import { documents, documentTexts } from '@/server/db/schema/documents';
import { CHUNKER_VERSION, chunkDocument } from '@/server/ingest/chunker';
import { parseDocx } from '@/server/ingest/parsers/docx';

import type { CatalogEntry } from '../../../data-gen/schemas/catalog';

export type IngestOptions = { force?: boolean; only?: string };

export type IngestDeps = {
  db: typeof appDb;
  embed: (texts: string[]) => Promise<number[][]>;
  embeddingModel: string;
  corpusDir: string;
};

export type IngestRow = {
  slug: string;
  status: 'embedded' | 'skipped' | 'failed';
  chunks: number;
  tokens: number;
  error?: string;
};

// A whole-corpus --force is the one way to move to another model (DATA_MODEL.md §6).
async function assertSingleEmbeddingModel(
  { db, embeddingModel }: IngestDeps,
  { force, only }: IngestOptions,
): Promise<void> {
  if (force && !only) return;
  const stored = await db.selectDistinct({ model: chunks.embeddingModel }).from(chunks);
  const others = stored.map(({ model }) => model).filter((model) => model !== embeddingModel);
  if (others.length > 0) {
    throw new AppError(
      'validation',
      `chunks hold embeddings from ${others.join(', ')}, not ${embeddingModel}; ` +
        'run pnpm ingest --force without --only to re-embed everything',
    );
  }
}

async function ingestDocument(
  entry: CatalogEntry,
  force: boolean,
  { db, embed, embeddingModel, corpusDir }: IngestDeps,
): Promise<IngestRow> {
  const sourcePath = path.posix.join(corpusDir, entry.type, `${entry.slug}.docx`);
  const buffer = await readFile(sourcePath);
  const checksum = createHash('sha256').update(buffer).digest('hex');

  const [existing] = await db
    .select({ checksum: documents.checksum, chunkerVersion: documents.chunkerVersion })
    .from(documents)
    .where(eq(documents.slug, entry.slug));
  if (!force && existing?.checksum === checksum && existing.chunkerVersion === CHUNKER_VERSION) {
    return { slug: entry.slug, status: 'skipped', chunks: 0, tokens: 0 };
  }

  const parsed = await parseDocx(buffer);
  const drafts = chunkDocument(parsed, entry.title);
  // Before the transaction, so no connection stays open during network calls. A failure here
  // leaves the database untouched.
  const vectors = await embed(drafts.map((c) => `${c.contextPrefix}\n${c.content}`));

  await db.transaction(async (tx) => {
    const fields = {
      title: entry.title,
      docType: entry.type,
      accessRoles: entry.roles,
      sourcePath,
      checksum,
      chunkerVersion: CHUNKER_VERSION,
      ingestedAt: sql`now()`,
    };
    const [document] = await tx
      .insert(documents)
      .values({ slug: entry.slug, ...fields })
      .onConflictDoUpdate({ target: documents.slug, set: fields })
      .returning({ id: documents.id });
    if (!document) throw new AppError('db_error', `Upsert returned no row for ${entry.slug}`);

    const { text, sections } = parsed;
    await tx
      .insert(documentTexts)
      .values({ documentId: document.id, text, sections })
      .onConflictDoUpdate({ target: documentTexts.documentId, set: { text, sections } });

    await tx.delete(chunks).where(eq(chunks.documentId, document.id));
    if (drafts.length > 0) {
      await tx.insert(chunks).values(
        drafts.map((draft, ordinal) => ({
          ...draft,
          documentId: document.id,
          ordinal,
          embedding: vectors[ordinal] as number[],
          embeddingModel,
        })),
      );
    }
  });

  return {
    slug: entry.slug,
    status: 'embedded',
    chunks: drafts.length,
    tokens: drafts.reduce((sum, draft) => sum + draft.tokenCount, 0),
  };
}

// A failed query's own message carries its parameters, which here are whole documents and vectors.
function describeFailure(err: unknown): string {
  const cause = err instanceof DrizzleQueryError ? err.cause : err;
  return cause instanceof Error ? cause.message : String(cause);
}

export async function ingestCorpus(
  catalog: CatalogEntry[],
  options: IngestOptions,
  deps: IngestDeps,
): Promise<IngestRow[]> {
  const entries = options.only ? catalog.filter((entry) => entry.slug === options.only) : catalog;
  if (entries.length === 0) {
    throw new AppError('validation', `No catalog entry with slug ${options.only}`);
  }
  await assertSingleEmbeddingModel(deps, options);

  const rows: IngestRow[] = [];
  for (const entry of entries) {
    try {
      rows.push(await ingestDocument(entry, options.force ?? false, deps));
    } catch (err) {
      rows.push({
        slug: entry.slug,
        status: 'failed',
        chunks: 0,
        tokens: 0,
        error: describeFailure(err),
      });
    }
  }
  return rows;
}
