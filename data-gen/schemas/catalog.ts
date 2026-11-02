import { z } from 'zod';

export const ROLES = ['sales', 'hr', 'ops', 'admin'] as const;
export const DOCUMENT_TYPES = ['msa', 'carrier_agreement', 'hr_policy', 'sop', 'rate_sheet'] as const;

const CATALOG_SIZE = 24;

export const catalogEntrySchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  title: z.string().min(1),
  type: z.enum(DOCUMENT_TYPES),
  roles: z.array(z.enum(ROLES)).min(1),
});

export const catalogSchema = z
  .array(catalogEntrySchema)
  .length(CATALOG_SIZE)
  .refine((entries) => new Set(entries.map((entry) => entry.slug)).size === entries.length, {
    message: 'slugs must be unique',
  });

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
