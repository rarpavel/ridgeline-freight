import { describe, expect, it, vi } from 'vitest';

import { refuseWithoutLlm } from '@/server/rag/gate';

vi.mock('server-only', () => ({}));

const SIM_FLOOR = 0.3;

describe('refuseWithoutLlm', () => {
  it.each([
    ['weak similarity, no all-terms match', 0.12, 0, true],
    ['weak similarity, an all-terms match', 0.12, 2, false],
    ['strong similarity, no all-terms match', 0.61, 0, false],
    ['strong similarity, an all-terms match', 0.61, 2, false],
  ])('with %s', (_, bestSim, ftsAllTermsMatches, expected) => {
    expect(refuseWithoutLlm({ bestSim, ftsAllTermsMatches }, SIM_FLOOR)).toBe(expected);
  });

  it('does not refuse at exactly the floor', () => {
    expect(refuseWithoutLlm({ bestSim: SIM_FLOOR, ftsAllTermsMatches: 0 }, SIM_FLOOR)).toBe(false);
  });

  it('treats a missing similarity as weak, so only an all-terms match can save the question', () => {
    expect(refuseWithoutLlm({ bestSim: null, ftsAllTermsMatches: 0 }, SIM_FLOOR)).toBe(true);
    expect(refuseWithoutLlm({ bestSim: null, ftsAllTermsMatches: 1 }, SIM_FLOOR)).toBe(false);
  });
});
