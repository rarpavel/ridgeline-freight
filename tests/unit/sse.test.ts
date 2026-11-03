import { describe, expect, it } from 'vitest';

import { encodeSseEvent } from '@/lib/sse';

describe('encodeSseEvent', () => {
  it('writes the event name and a JSON payload, ended by a blank line', () => {
    expect(encodeSseEvent({ event: 'delta', data: { text: 'hello' } })).toBe(
      'event: delta\ndata: {"text":"hello"}\n\n',
    );
  });

  it('keeps a multi-line payload on one data line', () => {
    const encoded = encodeSseEvent({ event: 'delta', data: { text: 'one\ntwo\n\nthree' } });

    expect(encoded.trimEnd().split('\n')).toHaveLength(2);
    expect(JSON.parse(encoded.split('data: ')[1] ?? '')).toEqual({ text: 'one\ntwo\n\nthree' });
  });
});
