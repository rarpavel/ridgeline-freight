import { describe, expect, it } from 'vitest';

import { encodeSseEvent, parseSseStream, type ChatEvent } from '@/lib/sse';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of parseSseStream(stream)) events.push(event);
  return events;
}

const encoder = new TextEncoder();

describe('parseSseStream', () => {
  const events: ChatEvent[] = [
    { event: 'delta', data: { text: 'Fee — $75\n\nnet [1]' } },
    { event: 'error', data: { code: 'llm_error', message: 'The model is unavailable.' } },
  ];
  const bytes = encoder.encode(events.map(encodeSseEvent).join(''));

  it('reads several events from one chunk', async () => {
    await expect(collect(streamOf([bytes]))).resolves.toEqual(events);
  });

  it('reads events split at every byte, including inside a multi-byte character', async () => {
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));

    await expect(collect(streamOf(chunks))).resolves.toEqual(events);
  });

  it('does not return an event cut off by the end of the stream', async () => {
    const cut = encoder.encode('event: delta\ndata: {"text":"a"}\n\nevent: done\ndata: {"ref');

    await expect(collect(streamOf([cut]))).resolves.toEqual([
      { event: 'delta', data: { text: 'a' } },
    ]);
  });

  it('skips an unknown event', async () => {
    const unknown = encoder.encode('event: ping\ndata: {}\n\nevent: delta\ndata: {"text":"a"}\n\n');

    await expect(collect(streamOf([unknown]))).resolves.toEqual([
      { event: 'delta', data: { text: 'a' } },
    ]);
  });
});

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
