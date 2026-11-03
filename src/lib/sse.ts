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
