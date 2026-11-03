import { describe, expect, it, vi } from 'vitest';

import { costOf, PRICING_AS_OF } from '@/server/llm/pricing';

import pricing from '../../config/pricing.json';

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({ logger: { warn: vi.fn() } }));

describe('costOf', () => {
  it('prices input and output tokens from pricing.json', () => {
    const { inputPer1M, outputPer1M } = pricing.models['gpt-5-mini'];

    const cost = costOf([{ model: 'gpt-5-mini', inputTokens: 1000, outputTokens: 200 }]);

    expect(cost).toBeCloseTo((1000 / 1e6) * inputPer1M + (200 / 1e6) * outputPer1M, 12);
  });

  it('adds up several calls', () => {
    const cost = costOf([
      { model: 'text-embedding-3-small', inputTokens: 1_000_000, outputTokens: 0 },
      { model: 'gpt-5-mini', inputTokens: 1_000_000, outputTokens: 1_000_000 },
    ]);

    const { models } = pricing;
    expect(cost).toBeCloseTo(
      models['text-embedding-3-small'].inputPer1M +
        models['gpt-5-mini'].inputPer1M +
        models['gpt-5-mini'].outputPer1M,
      12,
    );
  });

  it('has no cost for no calls', () => {
    expect(costOf([])).toBeNull();
  });

  it('has no cost at all when one model has no price', () => {
    const cost = costOf([
      { model: 'text-embedding-3-small', inputTokens: 10, outputTokens: 0 },
      { model: 'unpriced-model', inputTokens: 10, outputTokens: 10 },
    ]);

    expect(cost).toBeNull();
  });

  it('prices every model the app is configured to use and states when it was checked', () => {
    expect(Object.keys(pricing.models).sort()).toEqual([
      'claude-haiku-5-5',
      'gpt-5-mini',
      'text-embedding-3-small',
    ]);
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
