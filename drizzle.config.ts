import { existsSync } from 'node:fs';

import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside Next.js, and src/env.ts is server-only and requires every app secret,
// so this one file reads its connection string directly. Existing variables win over the file.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema',
  out: './drizzle',
  ...(url ? { dbCredentials: { url } } : {}),
});
