// No "server-only" here: drizzle-kit loads schema files outside Next.js, and they hold no secrets.
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import type { TraceCandidate } from './request-traces';
import type { ResultScores, RunMetrics } from '@/server/eval/metrics';

export type RetrievalConfig = {
  k: number;
  vectorTopK: number;
  ftsTopK: number;
  finalK: number;
  perDocCap: number;
  simFloor: number;
};

// CHECK constraints on category, split and role live in a custom migration (DATA_MODEL.md §4).
export const evalQuestions = pgTable('eval_questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  category: text('category').notNull(),
  split: text('split').notNull(),
  role: text('role').notNull(),
  question: text('question').notNull(),
  expectedAnswer: text('expected_answer'),
  expectedDocSlugs: text('expected_doc_slugs').array().notNull().default([]),
  sourceFactIds: text('source_fact_ids').array().notNull().default([]),
  distractorDocSlugs: text('distractor_doc_slugs').array().notNull().default([]),
  reviewed: boolean('reviewed').notNull().default(false),
  notes: text('notes'),
  datasetVersion: text('dataset_version').notNull(),
});

// The CHECK constraint on split lives in a custom migration (DATA_MODEL.md §4).
export const evalRuns = pgTable('eval_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label'),
  split: text('split').notNull(),
  model: text('model').notNull(),
  embeddingModel: text('embedding_model').notNull(),
  judgeModel: text('judge_model'),
  promptVersion: text('prompt_version').notNull(),
  retrievalConfig: jsonb('retrieval_config').$type<RetrievalConfig>().notNull(),
  gitSha: text('git_sha').notNull(),
  datasetVersion: text('dataset_version').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  metrics: jsonb('metrics').$type<RunMetrics>(),
});

export const evalResults = pgTable(
  'eval_results',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => evalQuestions.id, { onDelete: 'cascade' }),
    answer: text('answer').notNull(),
    refused: boolean('refused').notNull(),
    citedChunkIds: uuid('cited_chunk_ids').array().notNull().default([]),
    retrieved: jsonb('retrieved').$type<TraceCandidate[]>().notNull(),
    scores: jsonb('scores').$type<ResultScores>().notNull(),
    judgeRationale: text('judge_rationale'),
    ttftMs: integer('ttft_ms'),
    latencyMs: integer('latency_ms').notNull(),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6, mode: 'number' }),
    traceId: uuid('trace_id'),
  },
  (table) => [primaryKey({ columns: [table.runId, table.questionId] })],
);
