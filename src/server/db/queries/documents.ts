import 'server-only';

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { ViewerDocument } from '@/lib/document-blocks';
import { AppError } from '@/lib/errors';
import type { Role } from '@/server/auth/session';
import type { db as appDb } from '@/server/db/client';
import { chunks } from '@/server/db/schema/chunks';
import { documents, documentTexts } from '@/server/db/schema/documents';

type Deps = { db: typeof appDb };

const uuidSchema = z.uuid();

function isUuid(value: string | null): value is string {
  return uuidSchema.safeParse(value).success;
}

function isAllowed(roles: readonly Role[]) {
  // sql.param keeps the array as one parameter; a bare array would expand to a list.
  return sql`${documents.accessRoles} && ${sql.param(roles)}::text[]`;
}

function notFound(): AppError {
  return new AppError('not_found', 'This document does not exist.');
}

/** Runs after a role-filtered query found nothing. Reads the id alone, never a document's content. */
async function refuse(id: string, { db }: Deps): Promise<never> {
  const [existing] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.id, id));
  if (existing) throw new AppError('forbidden', 'Your role does not have access to this document.');
  throw notFound();
}

/**
 * The role filter is in the SQL, the chunk's range included (CLAUDE.md rule 1). A chunk that is
 * malformed, gone after a re-ingest or from another document leaves the document without a highlight.
 */
export async function findViewerDocument(
  { id, chunkId, roles }: { id: string; chunkId: string | null; roles: readonly Role[] },
  deps: Deps,
): Promise<ViewerDocument> {
  // Postgres rejects a malformed uuid; to the client it is one more document that does not exist.
  if (!isUuid(id)) throw notFound();

  const [row] = await deps.db
    .select({
      title: documents.title,
      text: documentTexts.text,
      sections: documentTexts.sections,
      charStart: chunks.charStart,
      charEnd: chunks.charEnd,
    })
    .from(documents)
    .innerJoin(documentTexts, eq(documentTexts.documentId, documents.id))
    .leftJoin(
      chunks,
      isUuid(chunkId)
        ? and(eq(chunks.id, chunkId), eq(chunks.documentId, documents.id))
        : sql`false`,
    )
    .where(and(eq(documents.id, id), isAllowed(roles)));
  if (!row) return refuse(id, deps);

  const { title, text, sections, charStart, charEnd } = row;
  const chunk = charStart !== null && charEnd !== null ? { charStart, charEnd } : null;
  return { id, title, text, sections, chunk };
}

export async function findDocumentSource(
  { id, roles }: { id: string; roles: readonly Role[] },
  deps: Deps,
): Promise<{ slug: string; sourcePath: string }> {
  if (!isUuid(id)) throw notFound();

  const [row] = await deps.db
    .select({ slug: documents.slug, sourcePath: documents.sourcePath })
    .from(documents)
    .where(and(eq(documents.id, id), isAllowed(roles)));
  return row ?? refuse(id, deps);
}
