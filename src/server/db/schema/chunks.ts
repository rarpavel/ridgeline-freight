// No "server-only" here: drizzle-kit loads schema files outside Next.js, and they hold no secrets.
import { index, integer, pgTable, text, unique, uuid, vector } from 'drizzle-orm/pg-core';

import { documents } from './documents';

// The generated tsv column, its GIN index and the CHECK constraints live in a custom migration
// (DATA_MODEL.md §4). No index on embedding on purpose (ADR-0004).
export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    sectionRef: text('section_ref'),
    sectionTitle: text('section_title'),
    contextPrefix: text('context_prefix').notNull(),
    content: text('content').notNull(),
    charStart: integer('char_start').notNull(),
    charEnd: integer('char_end').notNull(),
    tokenCount: integer('token_count').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    embeddingModel: text('embedding_model').notNull(),
  },
  (table) => [
    unique('chunks_document_id_ordinal_unique').on(table.documentId, table.ordinal),
    index('chunks_document_idx').on(table.documentId),
  ],
);
