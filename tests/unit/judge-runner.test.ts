import { describe, expect, it, vi } from 'vitest';

import { judgeResult, type JudgeInput } from '@/server/eval/judge-runner';

vi.mock('server-only', () => ({}));

const INPUT: JudgeInput = {
  category: 'direct',
  question: 'How many days does Harbor Point Foods have to pay?',
  role: 'sales',
  expectedAnswer: 'Net 30 (30 days).',
  facts: [{ value: 'Net 30', aliases: ['30 days'] }],
  answer: 'Harbor Point Foods pays within Net 30 [1].',
  refused: false,
  citedPassages: [{ n: 1, document: 'Harbor MSA', section: '3 Payment', text: 'Net 30 terms.' }],
};

const RATIONALE = 'The value matches the reference and appears in passage [1].';

function reply(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    correctness: 1,
    faithfulness: 1,
    claims: [{ claim: 'Payment is Net 30', supported: true, citation: 1 }],
    refusalCorrect: null,
    rationale: RATIONALE,
    ...overrides,
  });
}

function judge(input: JudgeInput, ...replies: string[]) {
  const complete = vi.fn<(prompt: string, signal: AbortSignal) => Promise<string>>();
  for (const text of replies) complete.mockResolvedValueOnce(text);
  const verdict = judgeResult(input, { complete, signal: new AbortController().signal });
  return { verdict, complete };
}

describe('judgeResult', () => {
  it('fills the rubric with every input', async () => {
    const { verdict, complete } = judge(INPUT, reply());
    await verdict;

    const prompt = complete.mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('QUESTION (direct, asked by role "sales"): How many days');
    expect(prompt).toContain(
      'REFERENCE ANSWER (may be null when the correct behavior is to refuse): Net 30',
    );
    expect(prompt).toContain(
      'SOURCE FACTS (canonical values and accepted aliases): [{"value":"Net 30"',
    );
    expect(prompt).toContain('SYSTEM ANSWER (refused=false): Harbor Point Foods');
    expect(prompt).toContain('"document":"Harbor MSA"');
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });

  it('renders a missing reference answer as null', async () => {
    const { verdict, complete } = judge(
      { ...INPUT, expectedAnswer: null, facts: [], answer: 'Not found.', refused: true },
      reply({ claims: [], refusalCorrect: true }),
    );
    await verdict;

    expect(complete.mock.calls[0]?.[0]).toContain('refuse): null\n');
  });

  it('keeps the scores and rationale of a valid reply', async () => {
    const { scores, rationale } = await judge(INPUT, reply()).verdict;

    expect(rationale).toBe(RATIONALE);
    expect(scores).toEqual({
      correctness: 1,
      faithfulness: 1,
      claims: [{ claim: 'Payment is Net 30', supported: true, citation: 1 }],
      judgeRefusalCorrect: null,
      needsReview: false,
    });
  });

  it('recomputes faithfulness from the claims: 0.9 with 2 of 4 supported is stored as 0.5', async () => {
    const claims = [true, true, false, false].map((supported, i) => ({
      claim: `Claim ${i}`,
      supported,
      citation: supported ? 1 : null,
    }));

    const { scores } = await judge(INPUT, reply({ faithfulness: 0.9, claims })).verdict;

    expect(scores.faithfulness).toBe(0.5);
  });

  it('gives 1 with no claims, as the rubric says for a pure refusal', async () => {
    const refusal = {
      ...INPUT,
      expectedAnswer: null,
      facts: [],
      answer: 'Not found.',
      refused: true,
    };

    const { scores } = await judge(
      refusal,
      reply({ faithfulness: 0.2, claims: [], refusalCorrect: true }),
    ).verdict;

    expect(scores).toMatchObject({ faithfulness: 1, needsReview: false });
  });

  it('reads a reply wrapped in a code fence', async () => {
    const { scores } = await judge(INPUT, `\`\`\`json\n${reply()}\n\`\`\``).verdict;

    expect(scores.correctness).toBe(1);
  });

  describe('invalid replies', () => {
    it('retries once with the error appended and uses the second reply', async () => {
      const { verdict, complete } = judge(INPUT, 'not json', reply());
      const { scores } = await verdict;

      expect(complete).toHaveBeenCalledTimes(2);
      expect(complete.mock.calls[1]?.[0]).toContain(complete.mock.calls[0]?.[0]);
      expect(complete.mock.calls[1]?.[0]).toContain('rejected');
      expect(scores.correctness).toBe(1);
    });

    it('returns judgeError after the second failure, without throwing', async () => {
      const { verdict, complete } = judge(INPUT, 'not json', 'still not json');
      const { scores, rationale } = await verdict;

      expect(complete).toHaveBeenCalledTimes(2);
      expect(scores.judgeError).toEqual(expect.any(String));
      expect(scores.correctness).toBeUndefined();
      expect(rationale).toBeNull();
    });

    it.each([
      ['correctness outside 0 or 1', { correctness: 0.5 }],
      ['a short rationale', { rationale: 'Too short' }],
      ['a missing field', { refusalCorrect: undefined }],
      ['an extra field', { confidence: 0.9 }],
    ])('rejects %s', async (_name, overrides) => {
      const { scores } = await judge(INPUT, reply(overrides), reply(overrides)).verdict;

      expect(scores.judgeError).toEqual(expect.any(String));
    });

    it('does not retry a provider failure, which the SDK has already retried', async () => {
      const complete = vi.fn().mockRejectedValue(new Error('Claude stopped early: max_tokens'));

      const { scores } = await judgeResult(INPUT, {
        complete,
        signal: new AbortController().signal,
      });

      expect(complete).toHaveBeenCalledTimes(1);
      expect(scores.judgeError).toContain('max_tokens');
    });
  });

  describe('needsReview', () => {
    const refusal = { ...INPUT, answer: 'Not found.', refused: true };

    it.each([
      ['an answer the judge calls a correct refusal', INPUT, true],
      ['an answer the judge calls a wrong refusal', INPUT, false],
      ['a refusal with a reference the judge calls correct', refusal, true],
      ['a refusal with a reference the judge leaves null', refusal, null],
      [
        'a refusal without a reference the judge calls wrong',
        { ...refusal, expectedAnswer: null },
        false,
      ],
    ])('flags %s', async (_name, input, refusalCorrect) => {
      const { scores } = await judge(input, reply({ refusalCorrect })).verdict;

      expect(scores).toMatchObject({ judgeRefusalCorrect: refusalCorrect, needsReview: true });
    });

    it.each([
      ['an answer left null', INPUT, null],
      ['a refusal with a reference called wrong', refusal, false],
      ['a refusal without a reference called correct', { ...refusal, expectedAnswer: null }, true],
    ])('leaves %s', async (_name, input, refusalCorrect) => {
      const { scores } = await judge(input, reply({ refusalCorrect })).verdict;

      expect(scores.needsReview).toBe(false);
    });

    it('flags an answer with no claims: its faithfulness of 1 checked nothing', async () => {
      const { scores } = await judge(INPUT, reply({ claims: [] })).verdict;

      expect(scores).toMatchObject({ faithfulness: 1, needsReview: true });
    });
  });
});
