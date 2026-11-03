import 'server-only';

import { and, cosineDistance, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';

import { AppError } from '@/lib/errors';
import type { Role } from '@/server/auth/session';
import type { db as appDb } from '@/server/db/client';
import { chunks } from '@/server/db/schema/chunks';
import { documents } from '@/server/db/schema/documents';
import type { EmbeddedQuery } from '@/server/llm/embeddings';
import { logger } from '@/server/logger';

import {
  DEFAULT_FUSE_OPTIONS,
  fuseRrf,
  type FtsHit,
  type FusedCandidate,
  type VectorHit,
} from './fuse';
import type { PromptChunk } from './prompt';

const VECTOR_TOP_K = 20;
const FTS_TOP_K = 20;

export type RetrieveDeps = { db: typeof appDb };

export type RetrievedLists = {
  vector: VectorHit[];
  fts: FtsHit[];
  ftsAllTermsMatches: number;
  vectorUnavailable: boolean;
};

export type RetrievalResult = {
  candidates: FusedCandidate[];
  bestSim: number | null;
  ftsMatches: number;
  ftsAllTermsMatches: number;
  vectorUnavailable: boolean;
  /** `null` when the embedding call failed. */
  embeddingTokens: number | null;
};

export type EmbedQuery = (text: string) => Promise<EmbeddedQuery>;

export type LoadedChunk = PromptChunk & { chunkId: string; documentId: string };

/**
 * The three statements of DATA_MODEL.md §3. Role filtering happens here and only here (CLAUDE.md
 * rule 1). A null embedding skips the vector statement. Repeatable read gives all one snapshot, so a
 * concurrent ingest can't show them different chunks of the same document.
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
              slug: documents.slug,
              sectionRef: chunks.sectionRef,
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
        // Any word may match, or a question rarely finds a chunk holding all of its words (ADR-0019).
        // plainto_tsquery only joins quoted lexemes with ' & ', and a lexeme never holds a space.
        const query = sql`replace(plainto_tsquery('english', ${question})::text, ' & ', ' | ')::tsquery`;
        const score = sql<number>`ts_rank_cd(${tsv}, ${query})`;
        const fts = await tx
          .select({
            chunkId: chunks.id,
            documentId: chunks.documentId,
            slug: documents.slug,
            sectionRef: chunks.sectionRef,
            score,
          })
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(sql`${tsv} @@ ${query} AND ${isAllowed}`)
          .orderBy(desc(score), chunks.id)
          .limit(FTS_TOP_K);

        // The gate reads this, not the list above, which nearly any question reaches (ADR-0019).
        const allTerms = sql`websearch_to_tsquery('english', ${question})`;
        const [allTermsRow] = await tx
          .select({ matches: count() })
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(sql`${tsv} @@ ${allTerms} AND ${isAllowed}`);

        return {
          vector,
          fts,
          ftsAllTermsMatches: allTermsRow?.matches ?? 0,
          vectorUnavailable: questionEmbedding === null,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  } catch (err) {
    // A failed query's own message carries its parameters, the whole vector among them.
    const cause = err instanceof DrizzleQueryError ? err.cause : err;
    throw new AppError('db_error', 'Retrieval query failed', { cause });
  }
}

async function embedQuestion(question: string, embed: EmbedQuery): Promise<EmbeddedQuery | null> {
  try {
    return await embed(question);
  } catch (err) {
    logger.warn({ err }, 'retrieval.vector_unavailable');
    return null;
  }
}

/**
 * The text behind the fused candidates, in their order, under the same role filter. A chunk replaced
 * by an ingest since retrieval is skipped; aliases are numbered from what this returns.
 */
export async function loadPromptChunks(
  { chunkIds, roles }: { chunkIds: readonly string[]; roles: readonly Role[] },
  { db }: RetrieveDeps,
): Promise<LoadedChunk[]> {
  if (chunkIds.length === 0) return [];
  try {
    const rows = await db
      .select({
        chunkId: chunks.id,
        documentId: chunks.documentId,
        documentTitle: documents.title,
        sectionRef: chunks.sectionRef,
        sectionTitle: chunks.sectionTitle,
        contextPrefix: chunks.contextPrefix,
        content: chunks.content,
      })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(
        and(
          inArray(chunks.id, [...chunkIds]),
          sql`${documents.accessRoles} && ${sql.param(roles)}::text[]`,
        ),
      );
    const byId = new Map(rows.map((row) => [row.chunkId, row]));
    return chunkIds.flatMap((chunkId) => byId.get(chunkId) ?? []);
  } catch (err) {
    const cause = err instanceof DrizzleQueryError ? err.cause : err;
    throw new AppError('db_error', 'Prompt chunk query failed', { cause });
  }
}

/** Embeds outside the transaction, so no connection waits on the network. */
export async function retrieve(
  { question, roles }: { question: string; roles: readonly Role[] },
  { db, embed }: RetrieveDeps & { embed: EmbedQuery },
): Promise<RetrievalResult> {
  const embedded = await embedQuestion(question, embed);
  const { vector, fts, ftsAllTermsMatches, vectorUnavailable } = await retrieveCandidates(
    { questionEmbedding: embedded?.embedding ?? null, question, roles },
    { db },
  );
  return {
    candidates: fuseRrf(vector, fts, DEFAULT_FUSE_OPTIONS),
    bestSim: vector[0]?.sim ?? null,
    ftsMatches: fts.length,
    ftsAllTermsMatches,
    vectorUnavailable,
    embeddingTokens: embedded?.tokens ?? null,
  };
}
