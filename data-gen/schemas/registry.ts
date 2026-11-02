import { z } from 'zod';

// Mirrors registry.schema.json; tests/unit/data-gen-schemas.test.ts keeps the two in sync.
export const FACT_CATEGORIES = [
  'payment_terms',
  'penalty',
  'liability_cap',
  'term_and_termination',
  'notice_period',
  'rate',
  'fee',
  'threshold',
  'policy_rule',
  'date',
  'party',
  'exception',
  'other',
] as const;

export const factSchema = z.strictObject({
  factId: z.string().regex(/^[a-z0-9-]+#[0-9]{2}$/),
  docSlug: z.string(),
  category: z.enum(FACT_CATEGORIES),
  statement: z.string().min(20),
  value: z.string(),
  aliases: z.array(z.string()).min(1),
  valueType: z.enum(['money', 'days', 'percent', 'date', 'number', 'text']),
  sectionHint: z.string().optional(),
  isException: z.boolean().default(false),
  differsFrom: z.array(z.string()).optional(),
  entityIds: z.array(z.string()).optional(),
});

export const registrySchema = z.object({
  version: z.string(),
  facts: z.array(factSchema),
});

// OpenAI strict mode needs every property to be required and rejects "default".
const generatedFactSchema = factSchema.extend({
  sectionHint: z.string(),
  isException: z.boolean(),
  differsFrom: z.array(z.string()),
  entityIds: z.array(z.string()),
});

export const generatedRegistrySchema = z.strictObject({
  version: z.string(),
  facts: z.array(generatedFactSchema),
});

export type Fact = z.infer<typeof factSchema>;
export type Registry = z.infer<typeof registrySchema>;
