import 'server-only';

import { cosineDistance, desc, eq, sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';

import { AppError } from '@/lib/errors';
import type { Role } from '@/server/auth/session';
import type { db as appDb } from '@/server/db/client';
import { chunks } from '@/server/db/schema/chunks';
import { documents } from '@/server/db/schema/documents';
import { logger } from '@/server/logger';

import {
  DEFAULT_FUSE_OPTIONS,
  fuseRrf,
  type FtsHit,
  type FusedCandidate,
  type VectorHit,
} from './fuse';

const VECTOR_TOP_K = 20;
const FTS_TOP_K = 20;

export type RetrieveDeps = { db: typeof appDb };

export type RetrievedLists = {
  vector: VectorHit[];
  fts: FtsHit[];
  vectorUnavailable: boolean;
};

export type RetrievalResult = {
  candidates: FusedCandidate[];
  bestSim: number | null;
  ftsMatches: number;
  vectorUnavailable: boolean;
};

/**
 * The two statements of DATA_MODEL.md §3. Role filtering happens here and only here (CLAUDE.md
 * rule 1). A null embedding runs FTS alone. Repeatable read gives both one snapshot, so a concurrent
 * ingest can't show them different chunks of the same document.
 */
export async function retrieveCandidates(
  {
    questionEmbedding,
    question,
    roles,
  }: { questionEmbedding: number[] | null; question: string; roles: readonly Role[] },
  { db }: RetrieveDeps,
): Promise<RetrievedLists> {
  // sql.param keeps the array as one parameter; a bare array would expand to a list.
  const isAllowed = sql`${documents.accessRoles} && ${sql.param(roles)}::text[]`;

  try {
    return await db.transaction(
      async (tx) => {
        let vector: VectorHit[] = [];
        if (questionEmbedding) {
          const distance = cosineDistance(chunks.embedding, questionEmbedding);
          vector = await tx
            .select({
              chunkId: chunks.id,
              documentId: chunks.documentId,
              sim: sql<number>`1 - (${distance})`,
            })
            .from(chunks)
            .innerJoin(documents, eq(documents.id, chunks.documentId))
            .where(isAllowed)
            .orderBy(distance, chunks.id)
            .limit(VECTOR_TOP_K);
        }

        // tsv isn't in the Drizzle schema (DATA_MODEL.md §4). No match is a normal, empty result.
        const tsv = sql`"chunks"."tsv"`;
        const query = sql`websearch_to_tsquery('english', ${question})`;
        const score = sql<number>`ts_rank_cd(${tsv}, ${query})`;
        const fts = await tx
          .select({ chunkId: chunks.id, documentId: chunks.documentId, score })
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(sql`${tsv} @@ ${query} AND ${isAllowed}`)
          .orderBy(desc(score), chunks.id)
          .limit(FTS_TOP_K);

        return { vector, fts, vectorUnavailable: questionEmbedding === null };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  } catch (err) {
    // A failed query's own message carries its parameters, the whole vector among them.
    const cause = err instanceof DrizzleQueryError ? err.cause : err;
    throw new AppError('db_error', 'Retrieval query failed', { cause });
  }
}

async function embedQuestion(
  question: string,
  embed: (texts: string[]) => Promise<number[][]>,
): Promise<number[] | null> {
  try {
    const [embedding] = await embed([question]);
    return embedding ?? null;
  } catch (err) {
    logger.warn({ err }, 'retrieval.vector_unavailable');
    return null;
  }
}

/** Embeds outside the transaction, so no connection waits on the network. */
export async function retrieve(
  { question, roles }: { question: string; roles: readonly Role[] },
  { db, embed }: RetrieveDeps & { embed: (texts: string[]) => Promise<number[][]> },
): Promise<RetrievalResult> {
  const questionEmbedding = await embedQuestion(question, embed);
  const { vector, fts, vectorUnavailable } = await retrieveCandidates(
    { questionEmbedding, question, roles },
    { db },
  );
  return {
    candidates: fuseRrf(vector, fts, DEFAULT_FUSE_OPTIONS),
    bestSim: vector[0]?.sim ?? null,
    ftsMatches: fts.length,
    vectorUnavailable,
  };
}
