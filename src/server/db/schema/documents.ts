// No "server-only" here: drizzle-kit loads schema files outside Next.js, and they hold no secrets.
import { date, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export type DocumentSection = {
  ref: string;
  title: string;
  charStart: number;
  charEnd: number;
};

// CHECK constraints on doc_type and access_roles live in a custom migration (DATA_MODEL.md §4).
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  docType: text('doc_type').notNull(),
  accessRoles: text('access_roles').array().notNull(),
  sourcePath: text('source_path').notNull().unique(),
  checksum: text('checksum').notNull(),
  effectiveDate: date('effective_date'),
  chunkerVersion: text('chunker_version').notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documentTexts = pgTable('document_texts', {
  documentId: uuid('document_id')
    .primaryKey()
    .references(() => documents.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  sections: jsonb('sections').$type<DocumentSection[]>().notNull(),
});
