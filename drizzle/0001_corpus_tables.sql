CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"section_ref" text,
	"section_title" text,
	"context_prefix" text NOT NULL,
	"content" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"embedding_model" text NOT NULL,
	CONSTRAINT "chunks_document_id_ordinal_unique" UNIQUE("document_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "document_texts" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"sections" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"doc_type" text NOT NULL,
	"access_roles" text[] NOT NULL,
	"source_path" text NOT NULL,
	"checksum" text NOT NULL,
	"effective_date" date,
	"chunker_version" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_slug_unique" UNIQUE("slug"),
	CONSTRAINT "documents_source_path_unique" UNIQUE("source_path")
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_texts" ADD CONSTRAINT "document_texts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_document_idx" ON "chunks" USING btree ("document_id");