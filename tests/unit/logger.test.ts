import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { loggerOptions } from '@/server/logger';

vi.mock('server-only', () => ({}));

function capture(fields: object): Record<string, unknown> {
  const lines: string[] = [];
  pino(loggerOptions, { write: (line: string) => lines.push(line) }).info(fields, 'event');
  return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
}

describe('logger', () => {
  it('redacts credentials', () => {
    const line = capture({
      authorization: 'Bearer secret',
      cookie: 'session=secret',
      llm: { apiKey: 'secret' },
      account: { password: 'secret' },
    });

    expect(JSON.stringify(line)).not.toContain('secret');
  });

  it('does not copy the pg client, with its password, from an error', () => {
    const err = Object.assign(new Error('terminating connection'), {
      code: '57P01',
      client: { password: 'secret' },
    });

    const line = capture({ err });

    expect(JSON.stringify(line)).not.toContain('secret');
    expect(line.err).toMatchObject({
      type: 'Error',
      message: 'terminating connection',
      code: '57P01',
      stack: expect.stringContaining('terminating connection'),
    });
  });

  it('keeps the causes of an AggregateError, whose own message can be empty', () => {
    // pg reports this when "localhost" resolves to both ::1 and 127.0.0.1 and both refuse.
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
      client: { password: 'secret' },
    });

    const line = capture({ err: new AggregateError([refused]) });

    expect(JSON.stringify(line)).not.toContain('secret');
    expect(line.err).toMatchObject({
      type: 'AggregateError',
      errors: [{ message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' }],
    });
  });

  it('keeps the cause of a wrapped error under the same field limits', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
      client: { password: 'secret' },
    });

    const line = capture({ err: new Error('Failed query: SELECT 1', { cause: refused }) });

    expect(JSON.stringify(line)).not.toContain('secret');
    expect(line.err).toMatchObject({
      message: 'Failed query: SELECT 1',
      cause: { message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' },
    });
  });

  it('keeps other fields', () => {
    expect(capture({ route: '/api/health', durationMs: 5 })).toMatchObject({
      route: '/api/health',
      durationMs: 5,
      msg: 'event',
    });
  });
});
