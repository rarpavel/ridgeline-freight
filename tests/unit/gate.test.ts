import { describe, expect, it, vi } from 'vitest';

import { refuseWithoutLlm } from '@/server/rag/gate';

vi.mock('server-only', () => ({}));

const SIM_FLOOR = 0.3;

describe('refuseWithoutLlm', () => {
  it.each([
    ['weak similarity, no FTS matches', 0.12, 0, true],
    ['weak similarity, FTS matches', 0.12, 2, false],
    ['strong similarity, no FTS matches', 0.61, 0, false],
    ['strong similarity, FTS matches', 0.61, 2, false],
  ])('with %s', (_, bestSim, ftsMatches, expected) => {
    expect(refuseWithoutLlm({ bestSim, ftsMatches }, SIM_FLOOR)).toBe(expected);
  });

  it('does not refuse at exactly the floor', () => {
    expect(refuseWithoutLlm({ bestSim: SIM_FLOOR, ftsMatches: 0 }, SIM_FLOOR)).toBe(false);
  });

  it('treats a missing similarity as weak, so only FTS can save the question', () => {
    expect(refuseWithoutLlm({ bestSim: null, ftsMatches: 0 }, SIM_FLOOR)).toBe(true);
    expect(refuseWithoutLlm({ bestSim: null, ftsMatches: 1 }, SIM_FLOOR)).toBe(false);
  });
});
