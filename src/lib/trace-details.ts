import type { TraceCandidate, TraceRetrieval } from '@/server/db/schema/request-traces';

import type { RefusalReason } from './sse';

/** What `GET /api/traces/:id` returns: no question, no account, no text the model generated. */
export type TraceDetails = {
  id: string;
  gate: 'answer' | 'refuse_gate';
  retrieval: TraceRetrieval;
  promptVersion: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  ttftMs: number | null;
  latencyMs: number | null;
  refused: boolean;
  refusalReason: RefusalReason | null;
  citationsValid: number;
  citationsDropped: number;
  error: string | null;
};

const NO_VALUE = '—';

export function formatScore(score: number | null): string {
  return score === null ? NO_VALUE : score.toFixed(3);
}

export function formatCost(costUsd: number | null): string {
  return costUsd === null ? NO_VALUE : `$${costUsd.toFixed(6)}`;
}

export function formatMs(ms: number | null): string {
  return ms === null ? NO_VALUE : `${ms} ms`;
}

export function formatTokens(inputTokens: number | null, outputTokens: number | null): string {
  return inputTokens === null || outputTokens === null
    ? NO_VALUE
    : `${inputTokens} in / ${outputTokens} out`;
}

export function splitCandidates(candidates: TraceCandidate[]) {
  return {
    inPrompt: candidates.filter(({ inPrompt }) => inPrompt),
    notInPrompt: candidates.filter(({ inPrompt }) => !inPrompt),
  };
}
