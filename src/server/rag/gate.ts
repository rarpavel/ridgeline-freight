import 'server-only';

export type GateSignals = {
  /** `null` when the embedding call failed or the role can read no chunks at all. */
  bestSim: number | null;
  /** Chunks holding every word of the question, not the wider FTS candidate list (ADR-0019). */
  ftsAllTermsMatches: number;
};

/**
 * Refuses without a model call only when both signals are weak (ADR-0004): a low cosine alone is
 * not enough, because an exact term match can still hold the answer.
 */
export function refuseWithoutLlm(
  { bestSim, ftsAllTermsMatches }: GateSignals,
  simFloor: number,
): boolean {
  return (bestSim === null || bestSim < simFloor) && ftsAllTermsMatches === 0;
}
