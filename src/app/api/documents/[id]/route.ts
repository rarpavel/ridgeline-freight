import { NextResponse } from 'next/server';

import { requireSession } from '@/server/auth/require';
import { db } from '@/server/db/client';
import { findViewerDocument } from '@/server/db/queries/documents';
import { errorResponse } from '@/server/http';

const ROUTE = '/api/documents/:id';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { role } = await requireSession();
    const { id } = await params;
    const chunkId = new URL(request.url).searchParams.get('chunk');

    const document = await findViewerDocument({ id, chunkId, roles: [role] }, { db });

    return NextResponse.json(document, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return errorResponse(err, ROUTE);
  }
}
