import './load-env';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { env } from '@/env';
import { openai } from '@/server/llm/client';
import { renderPrompt } from '@/server/prompts/render';

import type { CatalogEntry } from '../../data-gen/schemas/catalog';
import { registrySchema, type Fact } from '../../data-gen/schemas/registry';
import { describeError } from './describe-error';
import { checkDocument, type DocumentReport } from './document-checks';
import {
  buildWorldSlice,
  effectiveDateOf,
  generateChecked,
  parsePromptTemplate,
  parseTypeGuidance,
  readOption,
} from './document-generation';
import { loadRegistryDeps } from './load-registry-deps';

const OUTPUT_DIR = 'data/generated/md';
const PROMPT_PATH = 'data-gen/prompts/02-document-from-facts.md';
const DOCUMENT_TYPES = ['msa', 'carrier_agreement', 'hr_policy', 'sop'];
// Leaves room for reasoning tokens, which count against the limit on gpt-5 models.
const MAX_COMPLETION_TOKENS = 16000;
const CONCURRENCY = 4;

type Outcome = {
  slug: string;
  source: 'existing' | 'generated';
  attempts: number;
  report: DocumentReport;
};

async function completeText(prompt: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: env.DATAGEN_MODEL,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });
  const choice = response.choices[0];
  if (!choice?.message.content || choice.finish_reason === 'length') {
    throw new Error(`Model returned no full text, finish reason: ${choice?.finish_reason ?? 'none'}`);
  }
  return choice.message.content;
}

// Runs at most `limit` tasks at a time so a full run stays under the provider's rate limits.
async function mapWithLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) results[index] = await task(item);
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function printOutcome({ slug, source, attempts, report }: Outcome): void {
  const status = report.errors.length === 0 ? 'ok' : 'FAILED';
  console.log(
    `${status} ${slug}: ${source}, attempts ${attempts}, ${report.wordCount} words, ${report.sectionCount} sections`,
  );
  for (const error of report.errors) console.error(`  error: ${error}`);
  for (const warning of report.warnings) console.log(`  warning: ${warning}`);
  for (const { factId, sentence } of report.exceptionSentences) {
    console.log(`  exception ${factId}: ${sentence}`);
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const only = readOption('--only');
  const deps = loadRegistryDeps();
  const registry = registrySchema.parse(JSON.parse(readFileSync('data/registry.json', 'utf8')));
  const promptFile = readFileSync(PROMPT_PATH, 'utf8');
  const template = parsePromptTemplate(promptFile);

  const entries = deps.catalog.filter(
    (entry) => DOCUMENT_TYPES.includes(entry.type) && (!only || entry.slug === only),
  );
  if (entries.length === 0) throw new Error(`No document matches --only ${only}`);
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const factsOf = (slug: string): Fact[] => registry.facts.filter((fact) => fact.docSlug === slug);

  const processEntry = async (entry: CatalogEntry): Promise<Outcome> => {
    const facts = factsOf(entry.slug);
    const worldSlice = JSON.stringify(buildWorldSlice(entry, facts, deps.world));
    const factsJson = JSON.stringify(facts);
    const effectiveDate = effectiveDateOf(entry.slug, facts);
    const check = (markdown: string): DocumentReport =>
      checkDocument(markdown, {
        title: entry.title,
        facts,
        blocklist: deps.blocklist,
        allowedText: `${worldSlice}\n${factsJson}`,
      });

    const file = path.join(OUTPUT_DIR, `${entry.slug}.md`);
    if (existsSync(file) && !force) {
      const report = check(readFileSync(file, 'utf8').trim());
      return { slug: entry.slug, source: 'existing', attempts: 0, report };
    }

    const prompt = renderPrompt(template, {
      title: entry.title,
      slug: entry.slug,
      doc_type: entry.type,
      world_slice_json: worldSlice,
      facts_json: factsJson,
      effective_date: effectiveDate,
      type_guidance: parseTypeGuidance(promptFile, entry.type),
    });
    const { markdown, report, attempts } = await generateChecked(prompt, completeText, check);
    // A document that still fails is not written, so the next run generates it again.
    if (report.errors.length === 0) writeFileSync(file, `${markdown}\n`);
    return { slug: entry.slug, source: 'generated', attempts, report };
  };

  const outcomes = await mapWithLimit(entries, CONCURRENCY, processEntry);
  outcomes.forEach(printOutcome);

  const failed = outcomes.filter(({ report }) => report.errors.length > 0);
  const missingFacts = failed.filter(({ report }) =>
    report.errors.some((error) => error.startsWith('missing fact')),
  );
  console.log(
    `documents: ${outcomes.length}, failed: ${failed.length}, with missing facts: ${missingFacts.length} (${env.DATAGEN_MODEL})`,
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(describeError(err));
  process.exit(1);
});
