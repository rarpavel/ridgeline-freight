import 'server-only';

import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { db as appDb } from '@/server/db/client';
import { evalQuestions, evalResults, evalRuns } from '@/server/db/schema/eval';

import { QUESTION_CATEGORIES } from '../../../../data-gen/schemas/questions';

type Deps = { db: typeof appDb };

const uuidSchema = z.uuid();

const RUN_COLUMNS = {
  id: evalRuns.id,
  label: evalRuns.label,
  split: evalRuns.split,
  model: evalRuns.model,
  judgeModel: evalRuns.judgeModel,
  promptVersion: evalRuns.promptVersion,
  datasetVersion: evalRuns.datasetVersion,
  gitSha: evalRuns.gitSha,
  startedAt: evalRuns.startedAt,
  finishedAt: evalRuns.finishedAt,
  metrics: evalRuns.metrics,
};

export type EvalRunRow = Awaited<ReturnType<typeof listEvalRuns>>[number];
export type EvalResultRow = Awaited<ReturnType<typeof listEvalResults>>[number];

export async function listEvalRuns({ db }: Deps) {
  return db.select(RUN_COLUMNS).from(evalRuns).orderBy(desc(evalRuns.startedAt));
}

export async function findEvalRun(id: string, { db }: Deps) {
  // Postgres rejects a malformed uuid; to the caller it is one more run that does not exist.
  if (!uuidSchema.safeParse(id).success) return null;
  const [run] = await db.select(RUN_COLUMNS).from(evalRuns).where(eq(evalRuns.id, id));
  return run ?? null;
}

/** In the order of the dataset's categories, then by slug. */
export async function listEvalResults(runId: string, { db }: Deps) {
  const rows = await db
    .select({
      questionId: evalResults.questionId,
      slug: evalQuestions.slug,
      category: evalQuestions.category,
      question: evalQuestions.question,
      expectedAnswer: evalQuestions.expectedAnswer,
      answer: evalResults.answer,
      refused: evalResults.refused,
      scores: evalResults.scores,
      judgeRationale: evalResults.judgeRationale,
      latencyMs: evalResults.latencyMs,
      traceId: evalResults.traceId,
    })
    .from(evalResults)
    .innerJoin(evalQuestions, eq(evalResults.questionId, evalQuestions.id))
    .where(eq(evalResults.runId, runId))
    .orderBy(asc(evalQuestions.slug));

  const position = (category: string) =>
    (QUESTION_CATEGORIES as readonly string[]).indexOf(category);
  return rows.sort((a, b) => position(a.category) - position(b.category));
}
