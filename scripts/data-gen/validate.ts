import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { catalogSchema } from '../../data-gen/schemas/catalog';
import { registrySchema } from '../../data-gen/schemas/registry';
import { checkCorpusDocument, summarizeReports, type CorpusDocumentReport } from './corpus-checks';
import { describeError } from './describe-error';
import { parseBlocklist } from './text-checks';

const CORPUS_DIR = 'data/corpus';
const REPORT_PATH = 'data/generated/validation-report.json';

async function main(): Promise<void> {
  const catalog = catalogSchema.parse(JSON.parse(readFileSync('data/catalog.json', 'utf8')));
  const registry = registrySchema.parse(JSON.parse(readFileSync('data/registry.json', 'utf8')));
  const blocklist = parseBlocklist(readFileSync('data-gen/blocklist.txt', 'utf8'));

  const documents: CorpusDocumentReport[] = [];
  for (const { slug, type } of catalog) {
    const source = path.join(CORPUS_DIR, type, `${slug}.docx`);
    if (!existsSync(source)) throw new Error(`Missing DOCX: ${source}`);
    const facts = registry.facts.filter((fact) => fact.docSlug === slug);
    const report = await checkCorpusDocument({ slug, docx: readFileSync(source), facts, blocklist });
    documents.push(report);

    console.log(`${report.passed ? 'ok' : 'FAIL'} ${slug}: ${facts.length} facts`);
    for (const factId of report.missingFacts) console.error(`  missing fact ${factId}`);
    for (const error of report.errors) console.error(`  ${error}`);
  }

  const report = summarizeReports(documents);
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `documents: ${report.documentCount}, facts: ${report.factCount}, missing facts: ${report.missingFactCount}, report: ${REPORT_PATH}`,
  );
  if (!report.passed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(describeError(err));
  process.exit(1);
});
