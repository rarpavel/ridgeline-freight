import 'server-only';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from '@/env';
import { logger } from '@/server/logger';

import * as chunks from './schema/chunks';
import * as documents from './schema/documents';
import * as evaluation from './schema/eval';
import * as requestTraces from './schema/request-traces';

export const pool = new Pool({ connectionString: env.DATABASE_URL });

// An idle connection dropped by the server (Neon scale-to-zero, a restart) is reported here, and an
// "error" event with no listener kills the process. The pool discards that connection by itself.
pool.on('error', (err) => {
  logger.warn({ err }, 'db.pool_error');
});

export const db = drizzle(pool, {
  schema: { ...documents, ...chunks, ...requestTraces, ...evaluation },
});
