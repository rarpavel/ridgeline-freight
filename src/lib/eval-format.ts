import type { Metrics } from '@/server/eval/metrics';

const NO_VALUE = '—';

// A run from before a metric existed has no key for it, so undefined is as real as null here.
type Value = number | null | undefined;

function isMissing(value: Value): value is null | undefined {
  return value === null || value === undefined;
}

export function formatScore(value: Value): string {
  return isMissing(value) ? NO_VALUE : value.toFixed(3);
}

export function formatCount(value: Value): string {
  return isMissing(value) ? NO_VALUE : String(value);
}

export function formatMs(value: Value): string {
  return isMissing(value) ? NO_VALUE : `${value.toLocaleString('en-US')} ms`;
}

export function formatCost(value: Value): string {
  return isMissing(value) ? NO_VALUE : `$${value.toFixed(6)}`;
}

export function formatFlag(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return NO_VALUE;
  return value ? 'yes' : 'no';
}

/** In UTC, so the same run reads the same whatever the server's zone is. */
export function formatDate(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export const HEADLINE_METRICS: readonly {
  key: string;
  label: string;
  format: (metrics: Metrics | null | undefined) => string;
}[] = [
  { key: 'hit', label: 'Hit rate', format: (m) => formatScore(m?.retrievalHitRate) },
  { key: 'correctness', label: 'Correctness', format: (m) => formatScore(m?.correctness) },
  { key: 'faithfulness', label: 'Faithfulness', format: (m) => formatScore(m?.faithfulness) },
  { key: 'refusal', label: 'Refusal accuracy', format: (m) => formatScore(m?.refusalAccuracy) },
  { key: 'leaks', label: 'Leaks', format: (m) => formatCount(m?.leakCount) },
  { key: 'ttft', label: 'p50 TTFT', format: (m) => formatMs(m?.ttftP50) },
  { key: 'cost', label: 'Cost/question', format: (m) => formatCost(m?.costPerQuestion) },
];
