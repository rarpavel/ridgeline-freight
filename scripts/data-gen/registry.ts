import './load-env';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { env } from '@/env';
import { renderPrompt } from '@/server/prompts/render';

import { DOCUMENT_TYPES } from '../../data-gen/schemas/catalog';
import { generatedRegistrySchema, type Registry } from '../../data-gen/schemas/registry';
import { completeJson } from './complete-json';
import { describeError } from './describe-error';
import { loadRegistryDeps, printRegistryReport } from './load-registry-deps';
import { validateRegistry } from './registry-checks';

const REGISTRY_PATH = 'data/registry.json';
const PROMPT_PATH = 'data-gen/prompts/01-fact-registry.md';
const DATASET_VERSION = '2026.11-1';
// Leaves room for reasoning tokens, which count against the limit on gpt-5 models.
const MAX_COMPLETION_TOKENS = 32000;

function loadPartBPrompt(): string {
  const match = /## Part B[\s\S]*?```\n([\s\S]*?)\n```/.exec(readFileSync(PROMPT_PATH, 'utf8'));
  if (!match?.[1]) throw new Error(`Part B prompt not found in ${PROMPT_PATH}`);
  return match[1];
}

async function main(): Promise<void> {
  if (existsSync(REGISTRY_PATH) && !process.argv.includes('--force')) {
    console.log(`${REGISTRY_PATH} exists, nothing written. Pass --force to regenerate.`);
    return;
  }

  const deps = loadRegistryDeps();
  const template = loadPartBPrompt();
  const batches = await Promise.all(
    DOCUMENT_TYPES.map(async (docType) => {
      const prompt = renderPrompt(template, {
        doc_type: docType,
        world_json: JSON.stringify(deps.world),
        catalog_json: JSON.stringify(deps.catalog.filter((entry) => entry.type === docType)),
        dataset_version: DATASET_VERSION,
      });
      const raw = await completeJson(
        prompt,
        'fact_registry',
        generatedRegistrySchema,
        MAX_COMPLETION_TOKENS,
      );
      return generatedRegistrySchema.parse(raw).facts;
    }),
  );

  const registry: Registry = { version: DATASET_VERSION, facts: batches.flat() };
  // Written even when a rule fails: a failing registry is fixed by hand, not regenerated.
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`wrote ${REGISTRY_PATH} (${env.DATAGEN_MODEL})`);

  const passed = printRegistryReport(validateRegistry(registry, deps));
  if (!passed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(describeError(err));
  process.exit(1);
});
