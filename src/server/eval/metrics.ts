import 'server-only';

import type { TraceCandidate } from '@/server/db/schema/request-traces';

import type { QUESTION_CATEGORIES } from '../../../data-gen/schemas/questions';

export type Category = (typeof QUESTION_CATEGORIES)[number];

const FUSED_CANDIDATES = 20;
const ANSWERABLE: readonly Category[] = ['direct', 'comparison', 'exception'];
const UNANSWERABLE: readonly Category[] = ['no_answer', 'other_role'];

export type JudgeClaim = { claim: string; supported: boolean; citation: number | null };

/** Absent without a judge; only `judgeError` when the judge gave no usable reply. */
export type JudgeScores = {
  correctness?: 0 | 1;
  faithfulness?: number;
  claims?: JudgeClaim[];
  judgeRefusalCorrect?: boolean | null;
  needsReview?: boolean;
  judgeError?: string;
};

/** One question's row in `eval_results.scores`. Null means the question is outside the population. */
export type ResultScores = {
  retrievalHit: boolean | null;
  retrievalHit20: boolean | null;
  refusalCorrect: boolean | null;
  leak: boolean | null;
  citationsValid: number;
  citationsDropped: number;
} & JudgeScores;

export type ScoredResult = {
  category: Category;
  refused: boolean;
  ttftMs: number | null;
  latencyMs: number;
  costUsd: number | null;
  scores: ResultScores;
};

export const METRIC_KEYS = [
  'retrievalHitRate',
  'retrievalHitRate@20',
  'leakCount',
  'refusalAccuracy',
  'falseRefusalRate',
  'citationValidity',
  'ttftP50',
  'ttftP95',
  'latencyP50',
  'latencyP95',
  'costPerQuestion',
  'correctness',
  'faithfulness',
  'needsReview',
  'judgeErrors',
] as const;

export type Metrics = Record<(typeof METRIC_KEYS)[number], number | null> & { questions: number };

export type RunMetrics = {
  overall: Metrics;
  byCategory: Partial<Record<Category, Metrics>>;
};

/** A document it cannot look up counts as a leak, so a gap in the lookup cannot hide one. */
function isLeak(
  candidates: readonly TraceCandidate[],
  role: string,
  accessRolesBySlug: ReadonlyMap<string, readonly string[]>,
): boolean {
  return candidates.some(({ slug }) => !accessRolesBySlug.get(slug)?.includes(role));
}

export function scoreResult(
  {
    category,
    role,
    expectedDocSlugs,
  }: { category: Category; role: string; expectedDocSlugs: readonly string[] },
  {
    refused,
    candidates,
    citationsValid,
    citationsDropped,
    accessRolesBySlug,
  }: {
    refused: boolean;
    candidates: readonly TraceCandidate[];
    citationsValid: number;
    citationsDropped: number;
    accessRolesBySlug: ReadonlyMap<string, readonly string[]>;
  },
): ResultScores {
  const hasAll = (found: readonly TraceCandidate[]) =>
    expectedDocSlugs.every((slug) => found.some((candidate) => candidate.slug === slug));
  const answerable = ANSWERABLE.includes(category);

  return {
    retrievalHit: answerable ? hasAll(candidates.filter(({ inPrompt }) => inPrompt)) : null,
    // Candidates are stored best first, and fusion keeps more than the 20 this metric reads.
    retrievalHit20: answerable ? hasAll(candidates.slice(0, FUSED_CANDIDATES)) : null,
    refusalCorrect: UNANSWERABLE.includes(category) ? refused : null,
    leak: category === 'other_role' ? isLeak(candidates, role, accessRolesBySlug) : null,
    citationsValid,
    citationsDropped,
  };
}

/** Nearest rank, so the value is always one that was measured. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? null;
}

function share(flags: readonly boolean[]): number | null {
  if (flags.length === 0) return null;
  return flags.filter(Boolean).length / flags.length;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function metricsOf(results: readonly ScoredResult[]): Metrics {
  const answerable = results.filter(({ category }) => ANSWERABLE.includes(category));
  const answered = results.filter(({ refused }) => !refused);
  const valid = answered.reduce((sum, { scores }) => sum + scores.citationsValid, 0);
  const dropped = answered.reduce((sum, { scores }) => sum + scores.citationsDropped, 0);
  const ttfts = results.map(({ ttftMs }) => ttftMs).filter(isPresent);
  const latencies = results.map(({ latencyMs }) => latencyMs);
  const costs = results.map(({ costUsd }) => costUsd).filter(isPresent);
  const leaks = results.map(({ scores }) => scores.leak).filter(isPresent);
  const judged = results.filter(
    ({ scores }) => isPresent(scores.correctness) || isPresent(scores.judgeError),
  );

  return {
    questions: results.length,
    retrievalHitRate: share(results.map(({ scores }) => scores.retrievalHit).filter(isPresent)),
    'retrievalHitRate@20': share(
      results.map(({ scores }) => scores.retrievalHit20).filter(isPresent),
    ),
    // Null with nothing checked, so a run without other_role questions can't read as a clean pass.
    leakCount: leaks.length === 0 ? null : leaks.filter(Boolean).length,
    refusalAccuracy: share(results.map(({ scores }) => scores.refusalCorrect).filter(isPresent)),
    falseRefusalRate: share(answerable.map(({ refused }) => refused)),
    citationValidity: valid + dropped === 0 ? null : valid / (valid + dropped),
    ttftP50: percentile(ttfts, 50),
    ttftP95: percentile(ttfts, 95),
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    costPerQuestion: mean(costs),
    // Answered only: refusals are already measured by refusalAccuracy and falseRefusalRate, and the
    // faithfulness of 1 the rubric gives a refusal would inflate the number.
    correctness: mean(answered.map(({ scores }) => scores.correctness).filter(isPresent)),
    faithfulness: mean(answered.map(({ scores }) => scores.faithfulness).filter(isPresent)),
    needsReview:
      judged.length === 0 ? null : judged.filter(({ scores }) => scores.needsReview).length,
    judgeErrors:
      judged.length === 0 ? null : judged.filter(({ scores }) => scores.judgeError).length,
  };
}

export function aggregateMetrics(results: readonly ScoredResult[]): RunMetrics {
  const byCategory: RunMetrics['byCategory'] = {};
  for (const category of new Set(results.map((result) => result.category))) {
    byCategory[category] = metricsOf(results.filter((result) => result.category === category));
  }
  return { overall: metricsOf(results), byCategory };
}
