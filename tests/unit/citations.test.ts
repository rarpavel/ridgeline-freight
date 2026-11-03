import { describe, expect, it, vi } from 'vitest';

import { validateCitations } from '@/server/rag/citations';

vi.mock('server-only', () => ({}));

describe('validateCitations', () => {
  it('removes an unknown alias from the text and reports it', () => {
    expect(validateCitations('A [1] B [9]', 2)).toEqual({
      text: 'A [1] B',
      refused: false,
      valid: [1],
      dropped: [9],
    });
  });

  it('leaves an answer with only known aliases unchanged', () => {
    const answer = 'The credit is $250.00 per shipment [1], except for hazmat [2].\n- Step one [1]';

    expect(validateCitations(answer, 2)).toEqual({
      text: answer,
      refused: false,
      valid: [1, 2],
      dropped: [],
    });
  });

  it('keeps punctuation in place when it removes a marker', () => {
    expect(validateCitations('The fee applies [9].', 1).text).toBe('The fee applies.');
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
    const answer = 'Revision [2024] of [Appendix A] and [a1]';

    expect(validateCitations(answer, 8)).toEqual({
      text: answer,
      refused: false,
      valid: [],
      dropped: [],
    });
  });

  it('detects a refusal and strips its marker', () => {
    expect(validateCitations('NO_ANSWER: The documents do not say.', 3)).toEqual({
      text: 'The documents do not say.',
      refused: true,
      valid: [],
      dropped: [],
    });
  });

  it('counts every citation in a refusal as dropped', () => {
    expect(validateCitations('NO_ANSWER: Not covered [1].', 3)).toEqual({
      text: 'Not covered.',
      refused: true,
      valid: [],
      dropped: [1],
    });
  });

  it('does not treat NO_ANSWER: later in the answer as a refusal', () => {
    const answer = 'The documents cover penalties [1].\nNO_ANSWER: Nothing on insurance.';

    const { refused, text } = validateCitations(answer, 1);

    expect(refused).toBe(false);
    expect(text).toBe(answer);
  });
});
