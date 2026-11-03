CREATE TABLE "eval_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"category" text NOT NULL,
	"split" text NOT NULL,
	"role" text NOT NULL,
	"question" text NOT NULL,
	"expected_answer" text,
	"expected_doc_slugs" text[] DEFAULT '{}' NOT NULL,
	"source_fact_ids" text[] DEFAULT '{}' NOT NULL,
	"distractor_doc_slugs" text[] DEFAULT '{}' NOT NULL,
	"reviewed" boolean DEFAULT false NOT NULL,
	"notes" text,
	"dataset_version" text NOT NULL,
	CONSTRAINT "eval_questions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"run_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"answer" text NOT NULL,
	"refused" boolean NOT NULL,
	"cited_chunk_ids" uuid[] DEFAULT '{}' NOT NULL,
	"retrieved" jsonb NOT NULL,
	"scores" jsonb NOT NULL,
	"judge_rationale" text,
	"ttft_ms" integer,
	"latency_ms" integer NOT NULL,
	"cost_usd" numeric(10, 6),
	"trace_id" uuid,
	CONSTRAINT "eval_results_run_id_question_id_pk" PRIMARY KEY("run_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text,
	"split" text NOT NULL,
	"model" text NOT NULL,
	"embedding_model" text NOT NULL,
	"judge_model" text,
	"prompt_version" text NOT NULL,
	"retrieval_config" jsonb NOT NULL,
	"git_sha" text NOT NULL,
	"dataset_version" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"metrics" jsonb
);
--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_question_id_eval_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."eval_questions"("id") ON DELETE cascade ON UPDATE no action;