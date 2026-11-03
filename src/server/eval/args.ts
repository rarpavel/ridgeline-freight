import 'server-only';

import { parseArgs } from 'node:util';

import { z } from 'zod';

import type { RunEvalInput } from './runner';

const USAGE =
  'Usage: pnpm eval --split dev|test [--label <text>] [--sim-floor <0-1>] [--no-judge]\n' +
  '       pnpm eval --resume <runId> [--no-judge]';

const newRunSchema = z.object({
  split: z.enum(['dev', 'test']),
  label: z.string().min(1).optional(),
  // min(1) first: Number('') is 0, which turns the gate off.
  simFloor: z.string().min(1).transform(Number).pipe(z.number().min(0).max(1)).optional(),
});

export function parseEvalArgs(args: string[]): { input: RunEvalInput; noJudge: boolean } {
  const { values } = parseArgs({
    args,
    options: {
      split: { type: 'string' },
      label: { type: 'string' },
      'sim-floor': { type: 'string' },
      'no-judge': { type: 'boolean', default: false },
      resume: { type: 'string' },
    },
  });
  const noJudge = values['no-judge'];

  if (values.resume !== undefined) {
    // A resumed run keeps the split, label and floor it started with.
    const { split, label, 'sim-floor': simFloor } = values;
    if (split !== undefined || label !== undefined || simFloor !== undefined) {
      throw new Error(USAGE);
    }
    if (!z.uuid().safeParse(values.resume).success) throw new Error(USAGE);
    return { input: { resumeRunId: values.resume }, noJudge };
  }

  const parsed = newRunSchema.safeParse({
    split: values.split,
    label: values.label,
    simFloor: values['sim-floor'],
  });
  if (!parsed.success) throw new Error(USAGE);
  return { input: parsed.data, noJudge };
}
