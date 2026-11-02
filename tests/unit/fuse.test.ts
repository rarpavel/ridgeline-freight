import { describe, expect, it, vi } from 'vitest';

import { fuseRrf, type FtsHit, type VectorHit } from '@/server/rag/fuse';

vi.mock('server-only', () => ({}));

const OPTIONS = { k: 60, finalK: 8, perDocCap: 3 };

function vectorHit(chunkId: string, documentId = `doc-${chunkId}`, sim = 0.5): VectorHit {
  return { chunkId, documentId, sim };
}

function ftsHit(chunkId: string, documentId = `doc-${chunkId}`, score = 0.1): FtsHit {
  return { chunkId, documentId, score };
}

describe('fuseRrf', () => {
  it('sums 1/(k + rank) for a chunk in both lists and ranks it above single-list chunks', () => {
    const fused = fuseRrf(
      [vectorHit('only-vector'), vectorHit('both', 'doc-both', 0.7)],
      [ftsHit('only-fts'), ftsHit('both', 'doc-both', 0.4)],
      OPTIONS,
    );

    expect(fused.map(({ chunkId }) => chunkId)).toEqual(['both', 'only-vector', 'only-fts']);
    expect(fused[0]).toEqual({
      chunkId: 'both',
      documentId: 'doc-both',
      vectorRank: 2,
      vectorSim: 0.7,
      ftsRank: 2,
      ftsScore: 0.4,
      rrf: 1 / 62 + 1 / 62,
      inPrompt: true,
    });
  });

  it('leaves the fields of a list the chunk is not in as null', () => {
    const [vectorOnly, ftsOnly] = fuseRrf([vectorHit('a')], [ftsHit('b')], OPTIONS);

    expect(vectorOnly).toMatchObject({ vectorRank: 1, ftsRank: null, ftsScore: null });
    expect(ftsOnly).toMatchObject({ ftsRank: 1, vectorRank: null, vectorSim: null });
    expect(vectorOnly?.rrf).toBe(1 / 61);
  });

  it('honours k', () => {
    const [candidate] = fuseRrf([vectorHit('a')], [], { ...OPTIONS, k: 10 });

    expect(candidate?.rrf).toBe(1 / 11);
  });

  it('allows at most perDocCap chunks per document and fills up from the next ones', () => {
    const crowded = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => vectorHit(id, 'crowded'));
    const others = ['g', 'h', 'i', 'j', 'k', 'l'].map((id) => vectorHit(id));

    const fused = fuseRrf([...crowded, ...others], [], OPTIONS);
    const inPrompt = fused.filter((candidate) => candidate.inPrompt);

    expect(inPrompt.map(({ chunkId }) => chunkId)).toEqual([
      'a',
      'b',
      'c',
      'g',
      'h',
      'i',
      'j',
      'k',
    ]);
    expect(inPrompt.filter(({ documentId }) => documentId === 'crowded')).toHaveLength(3);
  });

  it('keeps candidates left out of the prompt, in score order, for the trace', () => {
    const fused = fuseRrf(
      ['a', 'b', 'c', 'd'].map((id) => vectorHit(id, 'same')),
      [],
      OPTIONS,
    );

    expect(fused.map(({ chunkId, inPrompt }) => [chunkId, inPrompt])).toEqual([
      ['a', true],
      ['b', true],
      ['c', true],
      ['d', false],
    ]);
  });

  it('stops at finalK', () => {
    const hits = ['a', 'b', 'c', 'd'].map((id) => vectorHit(id));

    const fused = fuseRrf(hits, [], { ...OPTIONS, finalK: 2 });

    expect(fused.filter(({ inPrompt }) => inPrompt).map(({ chunkId }) => chunkId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('breaks exact ties by vector rank first, the same way in any input order', () => {
    const vector = [vectorHit('a'), vectorHit('x'), vectorHit('b')];
    const fts = [ftsHit('b'), ftsHit('y'), ftsHit('a')];

    const fused = fuseRrf(vector, fts, OPTIONS);

    // a is (1, 3) and b is (3, 1): the same score from the same two ranks.
    expect(fused[0]?.rrf).toBe(fused[1]?.rrf);
    expect(fused.slice(0, 2).map(({ chunkId }) => chunkId)).toEqual(['a', 'b']);
    // x and y each hold rank 2 in one list.
    expect(fused.slice(2).map(({ chunkId }) => chunkId)).toEqual(['x', 'y']);
  });

  it('works with one list empty or both', () => {
    expect(fuseRrf([], [], OPTIONS)).toEqual([]);
    expect(fuseRrf([], [ftsHit('a')], OPTIONS).map(({ chunkId }) => chunkId)).toEqual(['a']);
  });
});
