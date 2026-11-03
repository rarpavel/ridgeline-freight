import { describe, expect, it, vi } from 'vitest';

import { parseEvalArgs } from '@/server/eval/args';

vi.mock('server-only', () => ({}));

const RUN_ID = '00000000-0000-4000-8000-000000000000';

describe('parseEvalArgs', () => {
  it('reads a new run with all its options', () => {
    expect(
      parseEvalArgs(['--split', 'dev', '--label', 'tuning', '--sim-floor', '0.28', '--no-judge']),
    ).toEqual({
      input: { split: 'dev', label: 'tuning', simFloor: 0.28 },
      noJudge: true,
    });
  });

  it('keeps the judge on and leaves the floor to the environment by default', () => {
    expect(parseEvalArgs(['--split', 'test'])).toEqual({
      input: { split: 'test' },
      noJudge: false,
    });
  });

  it('accepts a floor of 0 when it is written out', () => {
    expect(parseEvalArgs(['--split', 'dev', '--sim-floor', '0']).input).toMatchObject({
      simFloor: 0,
    });
  });

  it('reads a resume', () => {
    expect(parseEvalArgs(['--resume', RUN_ID, '--no-judge'])).toEqual({
      input: { resumeRunId: RUN_ID },
      noJudge: true,
    });
  });

  it.each([
    [['--no-judge']],
    [['--split', 'staging']],
    [['--split', 'dev', '--sim-floor', '2']],
    [['--split', 'dev', '--sim-floor', 'high']],
    [['--split', 'dev', '--sim-floor=']],
    [['--split', 'dev', '--label=']],
    [['--resume', 'not-a-uuid']],
    [['--resume', RUN_ID, '--split', 'dev']],
    [['--resume', RUN_ID, '--label=']],
    [['--resume', RUN_ID, '--sim-floor=']],
  ])('prints the usage for %j', (args) => {
    expect(() => parseEvalArgs(args)).toThrow('Usage: pnpm eval');
  });
});
