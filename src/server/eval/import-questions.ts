import 'server-only';

import { sql } from 'drizzle-orm';

import type { db as appDb } from '@/server/db/client';
import { evalQuestions } from '@/server/db/schema/eval';

import { evalQuestionsSchema } from '../../../data-gen/schemas/questions';

export type ImportQuestionsDeps = {
  db: typeof appDb;
  datasetVersion: string;
};

export type ImportQuestionsResult = {
  imported: number;
  skippedSlugs: string[];
};

// Validates the whole file first and writes in one statement, so a bad question writes nothing.
export async function importEvalQuestions(
  raw: unknown,
  { db, datasetVersion }: ImportQuestionsDeps,
): Promise<ImportQuestionsResult> {
  const questions = evalQuestionsSchema.parse(raw);
  const reviewed = questions.filter((question) => question.reviewed);
  const skippedSlugs = questions
    .filter((question) => !question.reviewed)
    .map((question) => question.slug);

  if (reviewed.length > 0) {
    await db
      .insert(evalQuestions)
      .values(reviewed.map((question) => ({ ...question, datasetVersion })))
      .onConflictDoUpdate({
        target: evalQuestions.slug,
        set: {
          category: sql`excluded.category`,
          split: sql`excluded.split`,
          role: sql`excluded.role`,
          question: sql`excluded.question`,
          expectedAnswer: sql`excluded.expected_answer`,
          expectedDocSlugs: sql`excluded.expected_doc_slugs`,
          sourceFactIds: sql`excluded.source_fact_ids`,
          distractorDocSlugs: sql`excluded.distractor_doc_slugs`,
          reviewed: sql`excluded.reviewed`,
          notes: sql`excluded.notes`,
          datasetVersion: sql`excluded.dataset_version`,
        },
      });
  }

  return { imported: reviewed.length, skippedSlugs };
}
