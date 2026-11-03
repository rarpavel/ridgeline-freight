import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { requireSession } from '@/server/auth/require';
import { db } from '@/server/db/client';
import { findDocumentSource } from '@/server/db/queries/documents';
import { errorResponse } from '@/server/http';

const ROUTE = '/api/documents/:id/original';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { role } = await requireSession();
    const { id } = await params;

    const { slug, sourcePath } = await findDocumentSource({ id, roles: [role] }, { db });
    // source_path is relative to the project root; next.config.ts ships data/corpus with this route.
    const file = await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), sourcePath));

    return new Response(new Uint8Array(file), {
      headers: {
        'Content-Type': DOCX_TYPE,
        // Slugs are ASCII kebab-case (CONVENTIONS.md §2), so the name needs no encoding.
        'Content-Disposition': `attachment; filename="${slug}.docx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return errorResponse(err, ROUTE);
  }
}
