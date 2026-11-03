CREATE TABLE "request_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"account" text NOT NULL,
	"role" text NOT NULL,
	"question" text NOT NULL,
	"embedding_model" text,
	"retrieval" jsonb NOT NULL,
	"gate" text NOT NULL,
	"prompt_version" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 6),
	"ttft_ms" integer,
	"latency_ms" integer,
	"refused" boolean DEFAULT false NOT NULL,
	"refusal_reason" text,
	"generated_text" text,
	"citations_valid" integer DEFAULT 0 NOT NULL,
	"citations_dropped" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "request_traces_created_idx" ON "request_traces" USING btree ("created_at" DESC NULLS LAST);