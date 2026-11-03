import { describe, expect, it } from 'vitest';

import {
  formatCost,
  formatMs,
  formatScore,
  formatTokens,
  splitCandidates,
} from '@/lib/trace-details';
import type { TraceCandidate } from '@/server/db/schema/request-traces';

function candidate(chunkId: string, inPrompt: boolean): TraceCandidate {
  return {
    chunkId,
    documentId: 'd',
    slug: 's',
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

describe('trace formatting', () => {
  it('shows scores with 3 decimals, and a dash for a list the chunk was not in', () => {
    expect(formatScore(0.61234)).toBe('0.612');
    expect(formatScore(0)).toBe('0.000');
    expect(formatScore(null)).toBe('—');
  });

  it('shows cost, time and tokens, with a dash when unknown', () => {
    expect(formatCost(0.000123)).toBe('$0.000123');
    expect(formatCost(null)).toBe('—');
    expect(formatMs(800)).toBe('800 ms');
    expect(formatMs(null)).toBe('—');
    expect(formatTokens(1000, 200)).toBe('1000 in / 200 out');
    expect(formatTokens(null, null)).toBe('—');
  });
});

describe('splitCandidates', () => {
  it('separates what the model was given, keeping the order', () => {
    const { inPrompt, notInPrompt } = splitCandidates([
      candidate('a', true),
      candidate('b', false),
      candidate('c', true),
    ]);

    expect(inPrompt.map(({ chunkId }) => chunkId)).toEqual(['a', 'c']);
    expect(notInPrompt.map(({ chunkId }) => chunkId)).toEqual(['b']);
  });
});
