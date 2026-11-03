import { z } from 'zod';

import { ROLES } from './catalog';

export const QUESTION_CATEGORIES = [
  'direct',
  'comparison',
  'exception',
  'no_answer',
  'other_role',
  'broad',
] as const;

// What prompt 04 returns.
export const generatedQuestionSchema = z.object({
  slug: z.string().regex(/^(direct|comparison|exception|no_answer|other_role|broad)-\d{2}$/),
  category: z.enum(QUESTION_CATEGORIES),
  role: z.enum(ROLES),
  question: z.string().min(20).max(200),
  expectedAnswer: z.string().nullable(),
  expectedDocSlugs: z.array(z.string()),
  sourceFactIds: z.array(z.string()),
  distractorDocSlugs: z.array(z.string()),
  notes: z.string(),
});

export const generatedQuestionsSchema = z.array(generatedQuestionSchema);

// What data/eval/questions.json stores: the script adds these fields after generation.
export const evalQuestionSchema = generatedQuestionSchema.extend({
  split: z.enum(['dev', 'test']),
  reviewed: z.boolean(),
  datasetVersion: z.string(),
});

export const evalQuestionsSchema = z.array(evalQuestionSchema);

export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;
export type EvalQuestion = z.infer<typeof evalQuestionSchema>;
