import { z } from 'zod';

const MAX_TABLES = 3;
const MAX_ROWS = 25;

const rateTableSchema = z
  .object({
    title: z.string(),
    columns: z.array(z.string()).min(2).max(8),
    rows: z.array(z.array(z.string())).max(MAX_ROWS),
  })
  .refine((table) => table.rows.every((row) => row.length === table.columns.length), {
    message: 'every row must have one cell per column',
  });

export const rateSheetSchema = z.object({
  title: z.string(),
  effectiveDate: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
  intro: z.string(),
  tables: z.array(rateTableSchema).max(MAX_TABLES),
  notes: z.array(z.string()),
});

export type RateSheet = z.infer<typeof rateSheetSchema>;
