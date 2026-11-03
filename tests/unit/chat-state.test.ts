import { describe, expect, it } from 'vitest';

import {
  chatReducer,
  failureFromResponse,
  formatCountdown,
  INITIAL_CHAT_STATE,
  nextRateLimitWindow,
  visibleText,
  type ChatState,
} from '@/lib/chat-state';
import type { ChatCitation, ChatEvent } from '@/lib/sse';

const citation: ChatCitation = {
  n: 1,
  chunkId: 'chunk-1',
  documentId: 'doc-1',
  title: 'Master Service Agreement',
  sectionRef: '3.3',
};

const doneData = {
  reason: null,
  usage: { inputTokens: 1, outputTokens: 1 },
  ttftMs: 1,
  latencyMs: 2,
  costUsd: null,
};

function run(events: ChatEvent[], from?: ChatState): ChatState {
  const start = from ?? chatReducer(INITIAL_CHAT_STATE, { type: 'submit', question: 'Q?' });
  return events.reduce((state, event) => chatReducer(state, { type: 'event', event }), start);
}

describe('chatReducer', () => {
  it('waits until the first delta, then appends text without citations', () => {
    const meta: ChatEvent = {
      event: 'meta',
      data: { traceId: 't', promptVersion: 'v1', model: 'm', gate: 'answer' },
    };

    expect(run([meta]).status).toBe('waiting');
    expect(
      run([
        meta,
        { event: 'delta', data: { text: 'Fee ' } },
        { event: 'delta', data: { text: '[1]' } },
      ]),
    ).toMatchObject({ status: 'streaming', text: 'Fee [1]', citations: null });
  });

  it('replaces the text with the validated one on citations', () => {
    const state = run([
      { event: 'delta', data: { text: 'Fee [1] [9]' } },
      { event: 'citations', data: { valid: [citation], dropped: [9], text: 'Fee [1]' } },
      { event: 'done', data: { refused: false, ...doneData } },
    ]);

    expect(state).toMatchObject({
      status: 'done',
      text: 'Fee [1]',
      citations: [citation],
      refused: false,
    });
  });

  it('marks a refusal on done', () => {
    const state = run([
      { event: 'citations', data: { valid: [], dropped: [], text: 'Not in the documents.' } },
      { event: 'done', data: { refused: true, ...doneData } },
    ]);

    expect(state).toMatchObject({ status: 'done', refused: true, text: 'Not in the documents.' });
  });

  it('drops the unvalidated partial text on an error event', () => {
    const state = run([
      { event: 'delta', data: { text: 'Partial' } },
      { event: 'error', data: { code: 'llm_error', message: 'The model is unavailable.' } },
    ]);

    expect(state).toMatchObject({
      status: 'failed',
      text: '',
      failure: { kind: 'error', message: 'The model is unavailable.' },
    });
  });

  it('drops the partial text when the request fails', () => {
    const partial = run([{ event: 'delta', data: { text: 'Partial' } }]);
    const failure = { kind: 'error', message: 'Lost.' } as const;

    expect(chatReducer(partial, { type: 'fail', failure })).toMatchObject({
      status: 'failed',
      text: '',
      failure,
    });
  });

  it('starts clean on the next question', () => {
    const finished = run([
      { event: 'citations', data: { valid: [citation], dropped: [], text: 'Fee [1]' } },
      { event: 'done', data: { refused: false, ...doneData } },
    ]);

    expect(chatReducer(finished, { type: 'submit', question: 'Next?' })).toEqual({
      ...INITIAL_CHAT_STATE,
      status: 'waiting',
      question: 'Next?',
    });
  });
});

describe('visibleText', () => {
  it.each([
    ['the start of the marker', 'NO_AN', ''],
    ['the whole marker', ' NO_ANSWER:', ''],
    ['the marker before the refusal text', 'NO_ANSWER: Not found.', 'Not found.'],
    ['nothing in a normal answer', 'The fee is $75 [1].', 'The fee is $75 [1].'],
  ])('hides %s while streaming', (_, text, expected) => {
    expect(visibleText({ text, citations: null })).toBe(expected);
  });

  it('shows the validated text as is', () => {
    expect(visibleText({ text: 'NO', citations: [] })).toBe('NO');
  });
});

describe('rate limit countdown', () => {
  it('finds the next whole UTC hour', () => {
    expect(nextRateLimitWindow(Date.UTC(2026, 10, 3, 8, 40, 15))).toBe(Date.UTC(2026, 10, 3, 9));
    expect(nextRateLimitWindow(Date.UTC(2026, 10, 3, 8))).toBe(Date.UTC(2026, 10, 3, 9));
  });

  it.each([
    [19 * 60_000 + 45_000, '19:45'],
    [61_000, '1:01'],
    [500, '0:01'],
    [0, '0:00'],
    [-5_000, '0:00'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatCountdown(ms)).toBe(expected);
  });
});

describe('failureFromResponse', () => {
  const now = Date.UTC(2026, 10, 3, 8, 40);

  it('maps 429 to the next window, whatever the body says', () => {
    expect(failureFromResponse(429, null, now)).toEqual({
      kind: 'rate_limited',
      retryAt: Date.UTC(2026, 10, 3, 9),
    });
  });

  it('uses the message of the error body', () => {
    const body = {
      error: { code: 'budget_exhausted', message: 'Demo budget for today is spent.' },
    };

    expect(failureFromResponse(503, body, now)).toEqual({
      kind: 'error',
      message: 'Demo budget for today is spent.',
    });
  });

  it.each([[null], ['<html>'], [{ error: { message: 5 } }]])('falls back on body %j', (body) => {
    expect(failureFromResponse(504, body, now)).toEqual({
      kind: 'error',
      message: 'Something went wrong.',
    });
  });
});
