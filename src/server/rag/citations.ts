import 'server-only';

import type { RefusalReason } from '@/lib/sse';

import { REFUSAL_TEXT } from './refusal';

const REFUSAL_MARKER = 'NO_ANSWER:';
// The spaces before a marker go with it, so removing one leaves no gap before the next word or dot.
const CITATION_MARKER = /[ \t]*\[(\d{1,2})\]/g;

export type ValidatedCitations = {
  text: string;
  refused: boolean;
  reason: Exclude<RefusalReason, 'gate'> | null;
  valid: number[];
  dropped: number[];
  /** The answer as the model wrote it, for the trace: `text` may have replaced it. */
  originalText: string;
};

/**
 * Checks the `[n]` markers of a finished answer against the passages it was given
 * (RAG_PIPELINE.md §2.6). `valid` and `dropped` hold each alias once, in order of first appearance.
 * A refusal cites nothing, so all its markers count as dropped. An answer left with no valid
 * citation becomes a refusal, because nothing in it can be checked against the documents.
 */
export function validateCitations(answer: string, passageCount: number): ValidatedCitations {
  const trimmed = answer.trim();
  const isModelRefusal = trimmed.startsWith(REFUSAL_MARKER);
  const body = isModelRefusal ? trimmed.slice(REFUSAL_MARKER.length) : trimmed;
  const lastAlias = isModelRefusal ? 0 : passageCount;

  const valid = new Set<number>();
  const dropped = new Set<number>();
  const text = body
    .replace(CITATION_MARKER, (marker, alias: string) => {
      const n = Number(alias);
      if (n >= 1 && n <= lastAlias) {
        valid.add(n);
        return marker;
      }
      dropped.add(n);
      return '';
    })
    .trim();

  const result = { valid: [...valid], dropped: [...dropped], originalText: answer };
  if (isModelRefusal) {
    return { ...result, text: text || REFUSAL_TEXT, refused: true, reason: 'model' };
  }
  if (valid.size === 0) {
    return { ...result, text: REFUSAL_TEXT, refused: true, reason: 'no_valid_citations' };
  }
  return { ...result, text, refused: false, reason: null };
}
