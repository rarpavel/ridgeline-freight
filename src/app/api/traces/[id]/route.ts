import { NextResponse } from 'next/server';
import { z } from 'zod';

import { AppError } from '@/lib/errors';
import { requireSession } from '@/server/auth/require';
import { db } from '@/server/db/client';
import { errorResponse } from '@/server/http';
import { findTraceDetails } from '@/server/rag/trace';

const ROUTE = '/api/traces/:id';

const idSchema = z.uuid();

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSession();
    const { id } = await params;

    // Postgres rejects a malformed uuid; to the client it is one more trace that does not exist.
    const trace = idSchema.safeParse(id).success
      ? await findTraceDetails({ id, user }, { db })
      : null;
    if (!trace) throw new AppError('not_found', 'This trace does not exist.');

    return NextResponse.json(trace, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return errorResponse(err, ROUTE);
  }
}
