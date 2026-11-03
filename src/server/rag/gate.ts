import 'server-only';

export type GateSignals = {
  /** `null` when the embedding call failed or the role can read no chunks at all. */
  bestSim: number | null;
  ftsMatches: number;
};

/**
 * Refuses without a model call only when both signals are weak (ADR-0004): a low cosine alone is
 * not enough, because an exact term match can still hold the answer.
 */
export function refuseWithoutLlm({ bestSim, ftsMatches }: GateSignals, simFloor: number): boolean {
  return (bestSim === null || bestSim < simFloor) && ftsMatches === 0;
}
