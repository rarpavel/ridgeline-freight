-- Custom migration: the CHECK constraints from DATA_MODEL.md §2 that are kept out of the Drizzle schema.
ALTER TABLE "eval_questions" ADD CONSTRAINT "eval_questions_category_check"
  CHECK ("category" IN ('direct', 'comparison', 'exception', 'no_answer', 'other_role'));--> statement-breakpoint
ALTER TABLE "eval_questions" ADD CONSTRAINT "eval_questions_split_check"
  CHECK ("split" IN ('dev', 'test'));--> statement-breakpoint
ALTER TABLE "eval_questions" ADD CONSTRAINT "eval_questions_role_check"
  CHECK ("role" IN ('sales', 'hr', 'ops', 'admin'));--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_split_check"
  CHECK ("split" IN ('dev', 'test', 'all'));
