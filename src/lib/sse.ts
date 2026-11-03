export type ChatErrorCode = 'llm_error' | 'db_error' | 'internal';

export type ChatCitation = {
  n: number;
  chunkId: string;
  documentId: string;
  title: string;
  sectionRef: string | null;
};

/** The streaming protocol of ARCHITECTURE.md §2.2. */
export type ChatEvent =
  | {
      event: 'meta';
      data: { traceId: string; promptVersion: string; model: string; gate: 'answer' | 'refuse' };
    }
  | { event: 'delta'; data: { text: string } }
  | { event: 'citations'; data: { valid: ChatCitation[]; dropped: number[]; text: string } }
  | {
      event: 'done';
      data: {
        refused: boolean;
        usage: { inputTokens: number; outputTokens: number };
        ttftMs: number | null;
        latencyMs: number;
        costUsd: number | null;
      };
    }
  | { event: 'error'; data: { code: ChatErrorCode; message: string } };

// JSON.stringify escapes newlines, so the payload is always one `data:` line.
export function encodeSseEvent({ event, data }: ChatEvent): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const EVENT_NAMES: ReadonlySet<string> = new Set(['meta', 'delta', 'citations', 'done', 'error']);

function parseSseBlock(block: string): ChatEvent | null {
  let event = '';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice('event: '.length);
    if (line.startsWith('data: ')) data = line.slice('data: '.length);
  }
  if (!EVENT_NAMES.has(event)) return null;
  return { event, data: JSON.parse(data) } as ChatEvent;
}

/**
 * Reads the events `encodeSseEvent` wrote, however the network split them. A block cut off by the
 * end of the stream is not returned, so a lost connection shows up as a missing terminal event.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        const event = parseSseBlock(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event) yield event;
        end = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel();
  }
}
