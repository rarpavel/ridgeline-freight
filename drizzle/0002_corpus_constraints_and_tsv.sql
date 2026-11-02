-- Custom migration: the CHECK constraints, generated column and index from DATA_MODEL.md §2
-- that are kept out of the Drizzle schema.
ALTER TABLE "documents" ADD CONSTRAINT "documents_doc_type_check"
  CHECK ("doc_type" IN ('msa', 'carrier_agreement', 'hr_policy', 'sop', 'rate_sheet'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_access_roles_check"
  CHECK (cardinality("access_roles") > 0 AND "access_roles" <@ ARRAY['sales', 'hr', 'ops', 'admin']);--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_char_range_check" CHECK ("char_end" > "char_start");--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_token_count_check" CHECK ("token_count" > 0);--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS
  (to_tsvector('english', coalesce("context_prefix", '') || ' ' || "content")) STORED;--> statement-breakpoint
CREATE INDEX "chunks_tsv_idx" ON "chunks" USING gin ("tsv");
