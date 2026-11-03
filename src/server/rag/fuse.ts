import 'server-only';

type HitSource = { chunkId: string; documentId: string; slug: string; sectionRef: string | null };

export type VectorHit = HitSource & { sim: number };
export type FtsHit = HitSource & { score: number };

export type FusedCandidate = HitSource & {
  vectorRank: number | null;
  vectorSim: number | null;
  ftsRank: number | null;
  ftsScore: number | null;
  rrf: number;
  inPrompt: boolean;
};

export type FuseOptions = { k: number; finalK: number; perDocCap: number };

export const DEFAULT_FUSE_OPTIONS: FuseOptions = { k: 60, finalK: 8, perDocCap: 3 };

// Ranks are unique within a list, so two chunks can't tie on both.
function compareCandidates(a: FusedCandidate, b: FusedCandidate): number {
  return (
    b.rrf - a.rrf ||
    (a.vectorRank ?? Infinity) - (b.vectorRank ?? Infinity) ||
    (a.ftsRank ?? Infinity) - (b.ftsRank ?? Infinity)
  );
}

/**
 * Reciprocal Rank Fusion (RAG_PIPELINE.md §2.2). Returns every candidate, best first, because the
 * trace records them all; `inPrompt` marks the ones that fit `finalK` and `perDocCap`.
 */
export function fuseRrf(
  vector: VectorHit[],
  fts: FtsHit[],
  { k, finalK, perDocCap }: FuseOptions,
): FusedCandidate[] {
  const byChunk = new Map<string, FusedCandidate>();
  const candidateFor = ({ chunkId, documentId, slug, sectionRef }: HitSource) => {
    const candidate = byChunk.get(chunkId) ?? {
      chunkId,
      documentId,
      slug,
      sectionRef,
      vectorRank: null,
      vectorSim: null,
      ftsRank: null,
      ftsScore: null,
      rrf: 0,
      inPrompt: false,
    };
    byChunk.set(chunkId, candidate);
    return candidate;
  };

  vector.forEach((hit, index) => {
    const candidate = candidateFor(hit);
    candidate.vectorRank = index + 1;
    candidate.vectorSim = hit.sim;
    candidate.rrf += 1 / (k + candidate.vectorRank);
  });
  fts.forEach((hit, index) => {
    const candidate = candidateFor(hit);
    candidate.ftsRank = index + 1;
    candidate.ftsScore = hit.score;
    candidate.rrf += 1 / (k + candidate.ftsRank);
  });

  const fused = [...byChunk.values()].sort(compareCandidates);

  const perDocument = new Map<string, number>();
  let selected = 0;
  for (const candidate of fused) {
    if (selected === finalK) break;
    const taken = perDocument.get(candidate.documentId) ?? 0;
    if (taken === perDocCap) continue;
    perDocument.set(candidate.documentId, taken + 1);
    candidate.inPrompt = true;
    selected += 1;
  }
  return fused;
}
