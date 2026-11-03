import './data-gen/load-env';

import { readFileSync } from 'node:fs';

import { db, pool } from '@/server/db/client';
import { importEvalQuestions } from '@/server/eval/import-questions';

import { describeError } from './data-gen/describe-error';

async function main(): Promise<boolean> {
  const raw: unknown = JSON.parse(readFileSync('data/eval/questions.json', 'utf8'));
  const datasetVersion = readFileSync('data/VERSION', 'utf8').trim();
  if (!datasetVersion) throw new Error('data/VERSION is empty');

  const { imported, skippedSlugs } = await importEvalQuestions(raw, { db, datasetVersion });

  for (const slug of skippedSlugs) console.warn(`${slug}: skipped, reviewed is false`);
  console.log(`Imported ${imported} questions (dataset ${datasetVersion})`);
  return true;
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
