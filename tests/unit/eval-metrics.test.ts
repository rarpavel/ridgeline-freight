import { describe, expect, it, vi } from 'vitest';

import type { TraceCandidate } from '@/server/db/schema/request-traces';
import {
  aggregateMetrics,
  METRIC_KEYS,
  percentile,
  scoreResult,
  type ScoredResult,
} from '@/server/eval/metrics';

vi.mock('server-only', () => ({}));

const ACCESS = new Map([
  ['msa-harbor', ['sales', 'admin']],
  ['hr-handbook', ['hr', 'admin']],
  ['sop-dock', ['ops', 'sales', 'admin']],
]);

function candidate(slug: string, inPrompt = true): TraceCandidate {
  return {
    chunkId: `chunk-${slug}`,
    documentId: `doc-${slug}`,
    slug,
    sectionRef: null,
    vectorRank: 1,
    vectorSim: 0.5,
    ftsRank: null,
    ftsScore: null,
    rrf: 0.01,
    inPrompt,
    cited: false,
  };
}

function scored(
  category: ScoredResult['category'],
  overrides: Partial<ScoredResult> = {},
): ScoredResult {
  return {
    category,
    refused: false,
    ttftMs: 100,
    latencyMs: 1000,
    costUsd: 0.01,
    scores: {
      retrievalHit: null,
      retrievalHit20: null,
      refusalCorrect: null,
      leak: null,
      citationsValid: 0,
      citationsDropped: 0,
      truncated: false,
      outputTokens: 500,
    },
    ...overrides,
  };
}

function scoresOf(overrides: Partial<ScoredResult['scores']>): ScoredResult['scores'] {
  return { ...scored('direct').scores, ...overrides };
}

describe('judge metrics', () => {
  const judged = { claims: [], judgeRefusalCorrect: null, needsReview: false };

  it('are null when nothing was judged', () => {
    expect(aggregateMetrics([scored('direct')]).overall).toMatchObject({
      correctness: null,
      faithfulness: null,
      needsReview: null,
      judgeErrors: null,
    });
  });

  it('average correctness and faithfulness over the answered only', () => {
    const { overall } = aggregateMetrics([
      scored('direct', { scores: scoresOf({ ...judged, correctness: 1, faithfulness: 1 }) }),
      scored('direct', { scores: scoresOf({ ...judged, correctness: 0, faithfulness: 0.5 }) }),
      scored('no_answer', {
        refused: true,
        scores: scoresOf({ ...judged, correctness: 1, faithfulness: 1 }),
      }),
    ]);

    expect(overall.correctness).toBe(0.5);
    expect(overall.faithfulness).toBe(0.75);
  });

  it('count flagged results and judge errors over all results, leaving errors out of the means', () => {
    const { overall, byCategory } = aggregateMetrics([
      scored('direct', { scores: scoresOf({ ...judged, correctness: 1, faithfulness: 1 }) }),
      scored('direct', { scores: scoresOf({ judgeError: 'Bad JSON' }) }),
      scored('no_answer', {
        refused: true,
        scores: scoresOf({ ...judged, correctness: 0, faithfulness: 1, needsReview: true }),
      }),
    ]);

    expect(overall).toMatchObject({ correctness: 1, needsReview: 1, judgeErrors: 1 });
    expect(byCategory.no_answer).toMatchObject({
      correctness: null,
      needsReview: 1,
      judgeErrors: 0,
    });
  });
});

describe('scoreResult', () => {
  const answerable = {
    category: 'direct' as const,
    role: 'sales',
    expectedDocSlugs: ['msa-harbor', 'sop-dock'],
  };

  it('hits only when every expected document has a chunk in the prompt', () => {
    const { retrievalHit, retrievalHit20 } = scoreResult(answerable, {
      refused: false,
      candidates: [candidate('msa-harbor'), candidate('sop-dock', false)],
      citationsValid: 1,
      citationsDropped: 0,
      truncated: false,
      outputTokens: 500,
      accessRolesBySlug: ACCESS,
    });

    expect(retrievalHit).toBe(false);
    expect(retrievalHit20).toBe(true);
  });

  it('looks at the top 20 fused candidates only for the @20 hit', () => {
    const fillers = Array.from({ length: 20 }, () => candidate('msa-harbor', false));
    const { retrievalHit20 } = scoreResult(answerable, {
      refused: false,
      candidates: [...fillers, candidate('sop-dock', false)],
      citationsValid: 0,
      citationsDropped: 0,
      truncated: false,
      outputTokens: 500,
      accessRolesBySlug: ACCESS,
    });

    expect(retrievalHit20).toBe(false);
  });

  it('scores a refusal as correct on no_answer and leaves hits and leaks out', () => {
    expect(
      scoreResult(
        { category: 'no_answer', role: 'sales', expectedDocSlugs: [] },
        {
          refused: true,
          candidates: [candidate('msa-harbor')],
          citationsValid: 0,
          citationsDropped: 0,
          truncated: false,
          outputTokens: 500,
          accessRolesBySlug: ACCESS,
        },
      ),
    ).toEqual({
      retrievalHit: null,
      retrievalHit20: null,
      refusalCorrect: true,
      leak: null,
      citationsValid: 0,
      citationsDropped: 0,
      truncated: false,
      outputTokens: 500,
    });
  });

  describe('leak on other_role', () => {
    const otherRole = {
      category: 'other_role' as const,
      role: 'sales',
      expectedDocSlugs: ['hr-handbook'],
    };
    const leakOf = (candidates: TraceCandidate[]) =>
      scoreResult(otherRole, {
        refused: true,
        candidates,
        citationsValid: 0,
        citationsDropped: 0,
        truncated: false,
        outputTokens: 500,
        accessRolesBySlug: ACCESS,
      }).leak;

    it('is false when every retrieved chunk is one the role may read', () => {
      expect(leakOf([candidate('msa-harbor'), candidate('sop-dock', false)])).toBe(false);
    });

    it('is true for a chunk of a document outside the role, also when not in the prompt', () => {
      expect(leakOf([candidate('msa-harbor'), candidate('hr-handbook', false)])).toBe(true);
    });

    it('is true for a document it cannot look up', () => {
      expect(leakOf([candidate('deleted-document')])).toBe(true);
    });
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const values = [40, 10, 30, 20];

    expect(percentile(values, 50)).toBe(20);
    expect(percentile(values, 95)).toBe(40);
    expect(percentile([7], 50)).toBe(7);
  });

  it('is null with no values', () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe('aggregateMetrics', () => {
  it('counts a refused broad question as a false refusal', () => {
    const { overall, byCategory } = aggregateMetrics([
      scored('broad', { refused: true }),
      scored('broad'),
    ]);

    expect(overall.falseRefusalRate).toBe(0.5);
    expect(byCategory.broad?.falseRefusalRate).toBe(0.5);
  });

  it('counts answers at the token limit, refused or not', () => {
    const { overall, byCategory } = aggregateMetrics([
      scored('broad', { scores: scoresOf({ truncated: true, outputTokens: 1500 }) }),
      scored('broad', { refused: true, scores: scoresOf({ truncated: true, outputTokens: 1500 }) }),
      scored('direct', { scores: scoresOf({ outputTokens: 300 }) }),
    ]);

    expect(overall).toMatchObject({ truncatedAnswers: 2, outputTokensMax: 1500 });
    expect(byCategory.direct).toMatchObject({ truncatedAnswers: 0, outputTokensMax: 300 });
  });

  it('has no largest answer when no question reached the model', () => {
    const { overall } = aggregateMetrics([
      scored('other_role', { refused: true, scores: scoresOf({ outputTokens: 0 }) }),
    ]);

    expect(overall).toMatchObject({ truncatedAnswers: 0, outputTokensMax: null });
  });

  it('has every metric of EVALUATION §2 overall and per category', () => {
    const { overall, byCategory } = aggregateMetrics([scored('direct'), scored('other_role')]);

    expect(Object.keys(overall)).toEqual(expect.arrayContaining([...METRIC_KEYS]));
    expect(Object.keys(byCategory).sort()).toEqual(['direct', 'other_role']);
    expect(Object.keys(byCategory.direct ?? {})).toEqual(expect.arrayContaining([...METRIC_KEYS]));
  });

  it('counts one leak from a synthetic other_role result', () => {
    const { overall, byCategory } = aggregateMetrics([
      scored('other_role', { scores: scoresOf({ leak: true, refusalCorrect: true }) }),
      scored('other_role', { scores: scoresOf({ leak: false, refusalCorrect: true }) }),
      scored('direct', { scores: scoresOf({ retrievalHit: true, retrievalHit20: true }) }),
    ]);

    expect(overall.leakCount).toBe(1);
    expect(byCategory.other_role?.leakCount).toBe(1);
    expect(byCategory.direct?.leakCount).toBeNull();
  });

  it('computes hit rates over the answerable categories only', () => {
    const { overall } = aggregateMetrics([
      scored('direct', { scores: scoresOf({ retrievalHit: true, retrievalHit20: true }) }),
      scored('comparison', { scores: scoresOf({ retrievalHit: false, retrievalHit20: true }) }),
      scored('no_answer', { refused: true, scores: scoresOf({ refusalCorrect: true }) }),
    ]);

    expect(overall.retrievalHitRate).toBe(0.5);
    expect(overall['retrievalHitRate@20']).toBe(1);
  });

  it('separates refusal accuracy from the false refusal rate', () => {
    const { overall } = aggregateMetrics([
      scored('no_answer', { refused: true, scores: scoresOf({ refusalCorrect: true }) }),
      scored('other_role', { refused: false, scores: scoresOf({ refusalCorrect: false }) }),
      scored('direct', { refused: true }),
      scored('exception', { refused: false }),
      scored('comparison', { refused: false }),
      scored('direct', { refused: false }),
    ]);

    expect(overall.refusalAccuracy).toBe(0.5);
    expect(overall.falseRefusalRate).toBe(0.25);
  });

  it('computes citation validity over answered questions only', () => {
    const { overall } = aggregateMetrics([
      scored('direct', { scores: scoresOf({ citationsValid: 3, citationsDropped: 1 }) }),
      scored('direct', {
        refused: true,
        scores: scoresOf({ citationsValid: 0, citationsDropped: 5 }),
      }),
    ]);

    expect(overall.citationValidity).toBe(0.75);
  });

  it('leaves gate refusals out of ttft and unknown costs out of the mean', () => {
    const { overall } = aggregateMetrics([
      scored('direct', { ttftMs: 100, latencyMs: 1000, costUsd: 0.02 }),
      scored('no_answer', { ttftMs: null, latencyMs: 10, costUsd: 0.04 }),
      scored('no_answer', { ttftMs: null, latencyMs: 20, costUsd: null }),
    ]);

    expect(overall.ttftP50).toBe(100);
    expect(overall.latencyP50).toBe(20);
    expect(overall.latencyP95).toBe(1000);
    expect(overall.costPerQuestion).toBeCloseTo(0.03);
    expect(overall.questions).toBe(3);
  });

  it('gives null, not zero, for a metric with an empty population', () => {
    const { overall, byCategory } = aggregateMetrics([scored('no_answer', { refused: true })]);

    expect(overall.retrievalHitRate).toBeNull();
    expect(overall.leakCount).toBeNull();
    expect(overall.falseRefusalRate).toBeNull();
    expect(overall.citationValidity).toBeNull();
    expect(byCategory.direct).toBeUndefined();
  });
});
