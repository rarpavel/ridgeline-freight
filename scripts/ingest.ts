import './data-gen/load-env';

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { env } from '@/env';
import { db, pool } from '@/server/db/client';
import { ingestCorpus } from '@/server/ingest/pipeline';
import { embedTexts } from '@/server/llm/embeddings';

import { catalogSchema } from '../data-gen/schemas/catalog';
import { describeError } from './data-gen/describe-error';

async function main(): Promise<boolean> {
  const { values } = parseArgs({
    options: { force: { type: 'boolean' }, only: { type: 'string' } },
  });
  const catalog = catalogSchema.parse(JSON.parse(readFileSync('data/catalog.json', 'utf8')));

  const rows = await ingestCorpus(catalog, values, {
    db,
    embed: embedTexts,
    embeddingModel: env.EMBEDDING_MODEL,
    corpusDir: 'data/corpus',
  });

  console.table(
    rows.map(({ slug, status, chunks, tokens }) => ({
      slug,
      chunks,
      tokens,
      embedded: status === 'embedded',
      skipped: status === 'skipped',
      failed: status === 'failed',
    })),
  );
  const failed = rows.filter((row) => row.status === 'failed');
  for (const { slug, error } of failed) console.error(`${slug}: ${error}`);
  return failed.length === 0;
}

main()
  .catch((err: unknown) => {
    console.error(describeError(err));
    return false;
  })
  .then(async (succeeded) => {
    await pool.end();
    process.exit(succeeded ? 0 : 1);
  });
