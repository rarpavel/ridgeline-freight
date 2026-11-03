import './data-gen/load-env';

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { env } from '@/env';
import { db, pool } from '@/server/db/client';
import { parseEvalArgs } from '@/server/eval/args';
import { METRIC_KEYS, type Metrics, type RunMetrics } from '@/server/eval/metrics';
import { runEval } from '@/server/eval/runner';
import { embedQuery } from '@/server/llm/embeddings';
import { completeWithClaude } from '@/server/llm/judge';
import { streamChat } from '@/server/rag/generate';

import { registrySchema } from '../data-gen/schemas/registry';
import { describeError } from './data-gen/describe-error';

const COUNT_KEYS: ReadonlySet<string> = new Set(['leakCount', 'needsReview', 'judgeErrors']);
// The model's hidden thinking counts against the limit (EVALUATION.md §4).
const JUDGE_MAX_TOKENS = 4000;

function format(key: (typeof METRIC_KEYS)[number], value: number | null): string {
  if (value === null) return '-';
  if (COUNT_KEYS.has(key) || key.startsWith('ttft') || key.startsWith('latency')) {
    return String(Math.round(value));
  }
  return key === 'costPerQuestion' ? `$${value.toFixed(5)}` : value.toFixed(3);
}

function tableRow(metrics: Metrics) {
  return {
    questions: metrics.questions,
    ...Object.fromEntries(METRIC_KEYS.map((key) => [key, format(key, metrics[key])])),
  };
}

function printMetrics({ overall, byCategory }: RunMetrics) {
  console.table({
    ...Object.fromEntries(
      Object.entries(byCategory).map(([category, metrics]) => [category, tableRow(metrics)]),
    ),
    overall: tableRow(overall),
  });
}

function loadFactsById() {
  const { facts } = registrySchema.parse(JSON.parse(readFileSync('data/registry.json', 'utf8')));
  return new Map(facts.map(({ factId, value, aliases }) => [factId, { value, aliases }]));
}

async function main(): Promise<boolean> {
  const { input, noJudge } = parseEvalArgs(process.argv.slice(2));
  // Before the run starts: finding this out at the judge step would waste the paid answers.
  if (!noJudge && !env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set: set it, or pass --no-judge to skip the judge');
  }

  const datasetVersion = readFileSync('data/VERSION', 'utf8').trim();
  if (!datasetVersion) throw new Error('data/VERSION is empty');

  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());

  const { runId, total, skipped, failures, metrics } = await runEval(input, {
    db,
    embed: embedQuery,
    llm: streamChat,
    ...(noJudge
      ? {}
      : {
          judge: {
            complete: (prompt, signal) =>
              completeWithClaude({ prompt, signal, maxTokens: JUDGE_MAX_TOKENS }),
            model: env.JUDGE_MODEL,
            factsById: loadFactsById(),
          },
        }),
    signal: abort.signal,
    gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    datasetVersion,
    questionsPath: 'data/eval/questions.json',
  });

  for (const { slug, reason } of failures) console.error(`${slug}: ${reason}`);
  if (metrics) printMetrics(metrics);
  if (skipped > 0) console.log(`Skipped ${skipped} of ${total} questions with a result`);
  console.log(`Run ${runId}${metrics ? '' : ` is not finished: pnpm eval --resume ${runId}`}`);
  return metrics !== null;
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
