import { createHash } from 'node:crypto';

const DIMENSIONS = 1536;

/** Deterministic and without a network call; says nothing about what the text means. */
export function fakeVector(text: string): number[] {
  const digest = createHash('sha256').update(text).digest();
  return Array.from(
    { length: DIMENSIONS },
    (_, index) => (digest[index % digest.length] ?? 0) / 255,
  );
}
