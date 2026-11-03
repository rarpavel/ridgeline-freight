-- Custom migration: adds `broad` to the CHECK constraint on the category (DATA_MODEL.md §2).
ALTER TABLE "eval_questions" DROP CONSTRAINT "eval_questions_category_check";--> statement-breakpoint
ALTER TABLE "eval_questions" ADD CONSTRAINT "eval_questions_category_check"
  CHECK ("category" IN ('direct', 'comparison', 'exception', 'no_answer', 'other_role', 'broad'));
