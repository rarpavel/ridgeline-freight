import 'server-only';

const REFUSAL_MARKER = 'NO_ANSWER:';
// The spaces before a marker go with it, so removing one leaves no gap before the next word or dot.
const CITATION_MARKER = /[ \t]*\[(\d{1,2})\]/g;

export type ValidatedCitations = {
  text: string;
  refused: boolean;
  valid: number[];
  dropped: number[];
};

/**
 * Checks the `[n]` markers of a finished answer against the passages it was given
 * (RAG_PIPELINE.md §2.6). `valid` and `dropped` hold each alias once, in order of first appearance.
 * A refusal cites nothing, so all its markers count as dropped.
 */
export function validateCitations(answer: string, passageCount: number): ValidatedCitations {
  const trimmed = answer.trim();
  const refused = trimmed.startsWith(REFUSAL_MARKER);
  const body = refused ? trimmed.slice(REFUSAL_MARKER.length) : trimmed;
  const lastAlias = refused ? 0 : passageCount;

  const valid = new Set<number>();
  const dropped = new Set<number>();
  const text = body.replace(CITATION_MARKER, (marker, alias: string) => {
    const n = Number(alias);
    if (n >= 1 && n <= lastAlias) {
      valid.add(n);
      return marker;
    }
    dropped.add(n);
    return '';
  });

  return { text: text.trim(), refused, valid: [...valid], dropped: [...dropped] };
}
