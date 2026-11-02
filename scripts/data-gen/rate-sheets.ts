import './load-env';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { env } from '@/env';
import { renderPrompt } from '@/server/prompts/render';

import type { CatalogEntry } from '../../data-gen/schemas/catalog';
import { rateSheetSchema } from '../../data-gen/schemas/rate-sheet';
import { registrySchema } from '../../data-gen/schemas/registry';
import { completeJson } from './complete-json';
import { describeError } from './describe-error';
import { effectiveDateOf, generateChecked, parsePromptTemplate, readOption } from './document-generation';
import { loadRegistryDeps } from './load-registry-deps';
import { checkRateSheetJson, SHEET_KINDS, type RateSheetReport } from './rate-sheet-checks';

const MARKDOWN_DIR = 'data/generated/md';
const JSON_DIR = 'data/generated/rate-sheets';
const PROMPT_PATH = 'data-gen/prompts/03-rate-sheet-tables.md';
// Leaves room for reasoning tokens, which count against the limit on gpt-5 models.
const MAX_COMPLETION_TOKENS = 16000;

type Outcome = {
  slug: string;
  source: 'existing' | 'generated';
  attempts: number;
  report: RateSheetReport;
};

function printOutcome({ slug, source, attempts, report }: Outcome): void {
  const status = report.errors.length === 0 ? 'ok' : 'FAILED';
  const tables = report.markdown?.match(/^## /gm)?.length ?? 0;
  console.log(`${status} ${slug}: ${source}, attempts ${attempts}, ${tables} sections`);
  for (const error of report.errors) console.error(`  error: ${error}`);
  for (const { factId, sentence } of report.exceptionSentences) {
    console.log(`  exception ${factId}: ${sentence}`);
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const only = readOption('--only');
  const deps = loadRegistryDeps();
  const registry = registrySchema.parse(JSON.parse(readFileSync('data/registry.json', 'utf8')));
  const template = parsePromptTemplate(readFileSync(PROMPT_PATH, 'utf8'));

  const entries = deps.catalog.filter(
    (entry) => entry.type === 'rate_sheet' && (!only || entry.slug === only),
  );
  if (entries.length === 0) throw new Error(`No rate sheet matches --only ${only}`);
  mkdirSync(MARKDOWN_DIR, { recursive: true });
  mkdirSync(JSON_DIR, { recursive: true });

  const processEntry = async (entry: CatalogEntry): Promise<Outcome> => {
    const kind = SHEET_KINDS[entry.slug];
    if (!kind) throw new Error(`${entry.slug}: unknown rate sheet kind`);
    const facts = registry.facts.filter((fact) => fact.docSlug === entry.slug);
    const effectiveDate = effectiveDateOf(entry.slug, facts);
    const check = (json: string): RateSheetReport =>
      checkRateSheetJson(json, {
        kind,
        title: entry.title,
        effectiveDate,
        facts,
        world: deps.world,
        blocklist: deps.blocklist,
      });

    // The JSON is the source: an existing file is only checked, and its Markdown is rewritten from it.
    const jsonFile = path.join(JSON_DIR, `${entry.slug}.json`);
    if (existsSync(jsonFile) && !force) {
      const report = check(readFileSync(jsonFile, 'utf8'));
      if (report.markdown && report.errors.length === 0) {
        writeFileSync(path.join(MARKDOWN_DIR, `${entry.slug}.md`), `${report.markdown}\n`);
      }
      return { slug: entry.slug, source: 'existing', attempts: 0, report };
    }

    const prompt = renderPrompt(template, {
      sheet_title: entry.title,
      sheet_kind: kind,
      world_lanes_json: JSON.stringify(deps.world.lanes),
      world_company_json: JSON.stringify(deps.world.company),
      facts_json: JSON.stringify(facts),
      effective_date: effectiveDate,
    });
    const complete = async (text: string): Promise<string> =>
      JSON.stringify(await completeJson(text, 'rate_sheet', rateSheetSchema, MAX_COMPLETION_TOKENS));
    const { markdown: json, report, attempts } = await generateChecked(prompt, complete, check);
    // A sheet that still fails is not written, so the next run generates it again.
    if (report.markdown && report.errors.length === 0) {
      writeFileSync(jsonFile, `${JSON.stringify(JSON.parse(json), null, 2)}\n`);
      writeFileSync(path.join(MARKDOWN_DIR, `${entry.slug}.md`), `${report.markdown}\n`);
    }
    return { slug: entry.slug, source: 'generated', attempts, report };
  };

  const outcomes = await Promise.all(entries.map(processEntry));
  outcomes.forEach(printOutcome);

  const failed = outcomes.filter(({ report }) => report.errors.length > 0);
  const missingFacts = failed.filter(({ report }) =>
    report.errors.some((error) => error.startsWith('missing fact')),
  );
  console.log(
    `rate sheets: ${outcomes.length}, failed: ${failed.length}, with missing facts: ${missingFacts.length} (${env.DATAGEN_MODEL})`,
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(describeError(err));
  process.exit(1);
});
