import './load-env';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { env } from '@/env';
import { renderPrompt } from '@/server/prompts/render';

import { catalogSchema } from '../../data-gen/schemas/catalog';
import {
  catalogEntities,
  worldMatchesCatalog,
  worldSchema,
  type World,
  type WorldEntity,
} from '../../data-gen/schemas/world';
import { completeJson } from './complete-json';
import { describeError } from './describe-error';
import { findBlocklistHits, findForbiddenPatterns, parseBlocklist } from './text-checks';

const WORLD_PATH = 'data/world.json';
const PROMPT_PATH = 'data-gen/prompts/01-fact-registry.md';
// Leaves room for reasoning tokens, which count against the limit on gpt-5 models.
const MAX_COMPLETION_TOKENS = 16000;

function loadPartAPrompt(): string {
  const match = /## Part A[\s\S]*?```\n([\s\S]*?)\n```/.exec(readFileSync(PROMPT_PATH, 'utf8'));
  if (!match?.[1]) throw new Error(`Part A prompt not found in ${PROMPT_PATH}`);
  return match[1];
}

function formatEntities(entities: WorldEntity[]): string {
  return entities.map((entity) => `${entity.id} | ${entity.name}`).join('; ');
}

function assertSafe(world: World): void {
  const text = JSON.stringify(world);
  const blocked = findBlocklistHits(text, parseBlocklist(readFileSync('data-gen/blocklist.txt', 'utf8')));
  if (blocked.length > 0) throw new Error(`Blocklist hits: ${blocked.join(', ')}`);
  const forbidden = findForbiddenPatterns(text);
  if (forbidden.length > 0) throw new Error(`Forbidden patterns: ${forbidden.join(', ')}`);
}

async function main(): Promise<void> {
  if (existsSync(WORLD_PATH) && !process.argv.includes('--force')) {
    console.log(`${WORLD_PATH} is frozen, nothing written. Pass --force to regenerate.`);
    return;
  }

  const catalog = catalogSchema.parse(JSON.parse(readFileSync('data/catalog.json', 'utf8')));
  const { customers, carriers } = catalogEntities(catalog);
  const prompt = renderPrompt(loadPartAPrompt(), {
    customers_list: formatEntities(customers),
    carriers_list: formatEntities(carriers),
  });

  const world = worldSchema.parse(
    await completeJson(prompt, 'world', worldSchema, MAX_COMPLETION_TOKENS),
  );
  if (!worldMatchesCatalog(world, catalog)) {
    throw new Error('Customers or carriers differ from data/catalog.json');
  }
  assertSafe(world);

  writeFileSync(WORLD_PATH, `${JSON.stringify(world, null, 2)}\n`);
  console.log(`wrote ${WORLD_PATH} (${env.DATAGEN_MODEL}); review and hand-edit it before committing`);
}

main().catch((err: unknown) => {
  console.error(describeError(err));
  process.exit(1);
});
