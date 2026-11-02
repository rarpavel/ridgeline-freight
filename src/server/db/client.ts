import 'server-only';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from '@/env';

import * as chunks from './schema/chunks';
import * as documents from './schema/documents';

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { schema: { ...documents, ...chunks } });
