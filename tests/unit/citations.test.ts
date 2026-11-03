import { describe, expect, it, vi } from 'vitest';

import { validateCitations } from '@/server/rag/citations';
import { REFUSAL_TEXT } from '@/server/rag/refusal';

vi.mock('server-only', () => ({}));

describe('validateCitations', () => {
  it('removes an unknown alias from the text and reports it', () => {
    expect(validateCitations('A [1] B [9]', 2)).toEqual({
      text: 'A [1] B',
      refused: false,
      reason: null,
      valid: [1],
      dropped: [9],
      originalText: 'A [1] B [9]',
    });
  });

  it('leaves an answer with only known aliases unchanged', () => {
    const answer = 'The credit is $250.00 per shipment [1], except for hazmat [2].\n- Step one [1]';

    expect(validateCitations(answer, 2)).toEqual({
      text: answer,
      refused: false,
      reason: null,
      valid: [1, 2],
      dropped: [],
      originalText: answer,
    });
  });

  it('keeps punctuation in place when it removes a marker', () => {
    expect(validateCitations('The fee [1] applies [9].', 1).text).toBe('The fee [1] applies.');
    expect(validateCitations('Adjacent [1][9] markers', 1).text).toBe('Adjacent [1] markers');
  });

  it('treats 0 and the alias just past the last passage as unknown', () => {
    const { text, valid, dropped } = validateCitations('A [0] B [2] C [3]', 2);

    expect(text).toBe('A B [2] C');
    expect(valid).toEqual([2]);
    expect(dropped).toEqual([0, 3]);
  });

  it('reports a repeated alias once, in order of first appearance', () => {
    const { valid, dropped } = validateCitations('[2] [1] [2] [8] [7] [8]', 2);

    expect(valid).toEqual([2, 1]);
    expect(dropped).toEqual([8, 7]);
  });

  it('ignores brackets that are not one or two digits', () => {
    const answer = 'Revision [2024] of [Appendix A] and [a1] [1]';

    expect(validateCitations(answer, 8)).toMatchObject({
      text: answer,
      refused: false,
      valid: [1],
      dropped: [],
    });
  });

  it('detects a refusal and strips its marker', () => {
    expect(validateCitations('NO_ANSWER: not covered', 3)).toEqual({
      text: 'not covered',
      refused: true,
      reason: 'model',
      valid: [],
      dropped: [],
      originalText: 'NO_ANSWER: not covered',
    });
  });

  it('counts every citation in a refusal as dropped', () => {
    expect(validateCitations('NO_ANSWER: Not covered [1].', 3)).toMatchObject({
      text: 'Not covered.',
      refused: true,
      reason: 'model',
      valid: [],
      dropped: [1],
    });
  });

  it('falls back to the fixed text when a refusal gives no reason', () => {
    expect(validateCitations('NO_ANSWER:', 3)).toMatchObject({
      text: REFUSAL_TEXT,
      refused: true,
      reason: 'model',
    });
  });

  it('does not treat NO_ANSWER: later in the answer as a refusal', () => {
    const answer = 'The documents cover penalties [1].\nNO_ANSWER: Nothing on insurance.';

    const { refused, text } = validateCitations(answer, 1);

    expect(refused).toBe(false);
    expect(text).toBe(answer);
  });

  it('turns an answer without any citation into a refusal and keeps the original', () => {
    const answer = 'The penalty is $250.00 per shipment.';

    expect(validateCitations(answer, 2)).toEqual({
      text: REFUSAL_TEXT,
      refused: true,
      reason: 'no_valid_citations',
      valid: [],
      dropped: [],
      originalText: answer,
    });
  });

  it('turns an answer with only unknown aliases into a refusal', () => {
    expect(validateCitations('The penalty is $250.00 [9].', 2)).toEqual({
      text: REFUSAL_TEXT,
      refused: true,
      reason: 'no_valid_citations',
      valid: [],
      dropped: [9],
      originalText: 'The penalty is $250.00 [9].',
    });
  });

  it('turns an empty answer into a refusal', () => {
    expect(validateCitations('', 2)).toMatchObject({
      text: REFUSAL_TEXT,
      refused: true,
      reason: 'no_valid_citations',
    });
  });
});
