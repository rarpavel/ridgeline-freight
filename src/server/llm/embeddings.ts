import 'server-only';

import { env } from '@/env';
import { AppError } from '@/lib/errors';

import { openai } from './client';

export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_BATCH_SIZE = 64;

export type EmbedBatch = (batch: string[]) => Promise<number[][]>;

// Retries on 429 and 5xx come from the client (client.ts).
const embedBatch: EmbedBatch = async (batch) => {
  const response = await openai.embeddings.create({ model: env.EMBEDDING_MODEL, input: batch });
  return [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
};

export type EmbeddedQuery = { embedding: number[]; tokens: number };

/** One text with what it cost; the chat path needs the tokens for its trace, ingest does not. */
export async function embedQuery(text: string): Promise<EmbeddedQuery> {
  const response = await openai.embeddings.create({ model: env.EMBEDDING_MODEL, input: [text] });
  const embedding = response.data[0]?.embedding;
  if (embedding?.length !== EMBEDDING_DIMENSIONS) {
    throw new AppError(
      'llm_error',
      `Expected an embedding of length ${EMBEDDING_DIMENSIONS}, got ${embedding?.length}`,
    );
  }
  return { embedding, tokens: response.usage.total_tokens };
}

export async function embedTexts(
  texts: string[],
  embed: EmbedBatch = embedBatch,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    const embedded = await embed(batch);
    if (embedded.length !== batch.length) {
      throw new AppError(
        'llm_error',
        `Expected ${batch.length} embeddings, got ${embedded.length}`,
      );
    }
    for (const vector of embedded) {
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new AppError(
          'llm_error',
          `Expected an embedding of length ${EMBEDDING_DIMENSIONS}, got ${vector.length}`,
        );
      }
      vectors.push(vector);
    }
  }
  return vectors;
}
