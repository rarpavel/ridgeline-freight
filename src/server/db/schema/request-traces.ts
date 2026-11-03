// No "server-only" here: drizzle-kit loads schema files outside Next.js, and they hold no secrets.
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import type { RefusalReason } from '@/lib/sse';

export type TraceCandidate = {
  chunkId: string;
  documentId: string;
  slug: string;
  sectionRef: string | null;
  vectorRank: number | null;
  vectorSim: number | null;
  ftsRank: number | null;
  ftsScore: number | null;
  rrf: number;
  inPrompt: boolean;
  cited: boolean;
};

export type TraceRetrieval = {
  candidates: TraceCandidate[];
  bestSim: number | null;
  simFloor: number;
  ftsMatches: number;
  vectorUnavailable: boolean;
};

// CHECK constraints on source, gate and refusal_reason live in a custom migration (DATA_MODEL.md §4).
export const requestTraces = pgTable(
  'request_traces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull(),
    account: text('account').notNull(),
    role: text('role').notNull(),
    question: text('question').notNull(),
    embeddingModel: text('embedding_model'),
    retrieval: jsonb('retrieval').$type<TraceRetrieval>().notNull(),
    gate: text('gate').$type<'answer' | 'refuse_gate'>().notNull(),
    promptVersion: text('prompt_version'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6, mode: 'number' }),
    ttftMs: integer('ttft_ms'),
    latencyMs: integer('latency_ms'),
    refused: boolean('refused').notNull().default(false),
    refusalReason: text('refusal_reason').$type<RefusalReason>(),
    generatedText: text('generated_text'),
    citationsValid: integer('citations_valid').notNull().default(0),
    citationsDropped: integer('citations_dropped').notNull().default(0),
    error: text('error'),
  },
  (table) => [index('request_traces_created_idx').on(table.createdAt.desc())],
);
