-- Custom migration: the CHECK constraints from DATA_MODEL.md §2 that are kept out of the Drizzle schema.
ALTER TABLE "request_traces" ADD CONSTRAINT "request_traces_source_check"
  CHECK ("source" IN ('chat', 'eval'));--> statement-breakpoint
ALTER TABLE "request_traces" ADD CONSTRAINT "request_traces_gate_check"
  CHECK ("gate" IN ('answer', 'refuse_gate'));--> statement-breakpoint
ALTER TABLE "request_traces" ADD CONSTRAINT "request_traces_refusal_reason_check"
  CHECK ("refusal_reason" IN ('gate', 'model', 'no_valid_citations'));
