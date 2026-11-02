import { describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';

describe('AppError', () => {
  it('carries code, safe message and the status mapped from the code', () => {
    const error = new AppError('rate_limited', 'Too many requests');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AppError');
    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.safeMessage).toBe('Too many requests');
  });

  it.each([
    ['budget_exhausted', 503],
    ['unauthorized', 401],
    ['forbidden', 403],
    ['not_found', 404],
    ['validation', 400],
    ['llm_error', 502],
    ['db_error', 503],
    ['internal', 500],
  ] as const)('maps %s to HTTP %i', (code, status) => {
    expect(new AppError(code, 'safe').status).toBe(status);
  });

  it('keeps the underlying cause for logs', () => {
    const cause = new Error('connection refused at 10.0.0.1');

    expect(new AppError('db_error', 'Database unavailable', { cause }).cause).toBe(cause);
  });
});
