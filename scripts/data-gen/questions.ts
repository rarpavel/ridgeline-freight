import './load-env';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { env } from '@/env';
import { completeWithClaude } from '@/server/llm/judge';
import { renderPrompt } from '@/server/prompts/render';

import {
  evalQuestionsSchema,
  QUESTION_CATEGORIES,
  type EvalQuestion,
  type GeneratedQuestion,
} from '../../data-gen/schemas/questions';
import { registrySchema } from '../../data-gen/schemas/registry';
import { describeError } from './describe-error';
import { generateChecked, parsePromptTemplate } from './document-generation';
import { loadRegistryDeps } from './load-registry-deps';
import {
  assignSplits,
  CATEGORY_COUNTS,
  checkBatch,
  checkQuestionSet,
  parseBatch,
  type QuestionDeps,
} from './question-checks';

const QUESTIONS_PATH = 'data/eval/questions.json';
const PROMPT_PATH = 'data-gen/prompts/04-eval-questions.md';
// 8,000 cut off the 16 direct questions. The SDK refuses a non-streaming call above about 21,000.
const MAX_TOKENS = 20000;

function printSet(questions: EvalQuestion[], errors: string[]): void {
  for (const category of QUESTION_CATEGORIES) {
    const batch = questions.filter((question) => question.category === category);
    const dev = batch.filter(({ split }) => split === 'dev').length;
    console.log(`${category}: ${batch.length} (dev ${dev}, test ${batch.length - dev})`);
  }
  const roles = questions.map(({ role }) => role);
  const roleCounts = [...new Set(roles)].map(
    (role) => `${role} ${roles.filter((candidate) => candidate === role).length}`,
  );
  console.log(`roles: ${roleCounts.join(', ')}`);
  for (const error of errors) console.error(error);
  console.log(errors.length === 0 ? 'questions ok' : `${errors.length} errors`);
}

async function generateBatch(
  category: GeneratedQuestion['category'],
  template: string,
  worldJson: string,
  catalogJson: string,
  registryJson: string,
  deps: QuestionDeps,
): Promise<{ questions: GeneratedQuestion[]; errors: string[] }> {
  const prompt = renderPrompt(template, {
    category,
    count: String(CATEGORY_COUNTS[category]),
    world_json: worldJson,
    catalog_json: catalogJson,
    registry_json: registryJson,
  });
  const { markdown, report, attempts } = await generateChecked(
    prompt,
    (current) =>
      completeWithClaude({
        prompt: current,
        model: env.DATAGEN_QUESTIONS_MODEL,
        maxTokens: MAX_TOKENS,
      }),
    (reply) => {
      const parsed = parseBatch(reply);
      return { errors: [...parsed.errors, ...checkBatch(parsed.questions, category, deps)] };
    },
  );
  console.log(`${category}: attempts ${attempts}, errors ${report.errors.length}`);
  return { questions: parseBatch(markdown).questions, errors: report.errors };
}

async function main(): Promise<void> {
  const { catalog, world, blocklist } = loadRegistryDeps();
  const registry = registrySchema.parse(JSON.parse(readFileSync('data/registry.json', 'utf8')));
  const deps: QuestionDeps = { catalog, facts: registry.facts, blocklist };

  // An existing file is only checked, so a run costs nothing and hand edits are kept.
  if (existsSync(QUESTIONS_PATH) && !process.argv.includes('--force')) {
    const questions = evalQuestionsSchema.parse(JSON.parse(readFileSync(QUESTIONS_PATH, 'utf8')));
    const errors = checkQuestionSet(questions, deps);
    printSet(questions, errors);
    if (errors.length > 0) process.exit(1);
    return;
  }

  const template = parsePromptTemplate(readFileSync(PROMPT_PATH, 'utf8'));
  const worldJson = JSON.stringify(world);
  const catalogJson = JSON.stringify(catalog);
  const registryJson = JSON.stringify(registry.facts);

  const batches: GeneratedQuestion[][] = [];
  const failures: string[] = [];
  // One call at a time: each carries the whole registry, which is heavy on the input token rate limit.
  for (const category of QUESTION_CATEGORIES) {
    const batch = await generateBatch(category, template, worldJson, catalogJson, registryJson, deps);
    batches.push(batch.questions);
    failures.push(...batch.errors);
  }

  const questions: EvalQuestion[] = assignSplits(batches.flat()).map((question) => ({
    ...question,
    reviewed: false,
    datasetVersion: registry.version,
  }));
  const errors = [...failures, ...checkQuestionSet(questions, deps)];
  printSet(questions, errors);
  // A set that fails a check is not written, so the next run generates it again.
  if (errors.length > 0) process.exit(1);
  writeFileSync(QUESTIONS_PATH, `${JSON.stringify(questions, null, 2)}\n`);
  console.log(`wrote ${QUESTIONS_PATH} (${env.DATAGEN_QUESTIONS_MODEL})`);
}

main().catch((err: unknown) => {
  console.error(describeError(err));
  process.exit(1);
});
