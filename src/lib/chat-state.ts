import type { ChatCitation, ChatEvent } from './sse';

export type ChatFailure =
  { kind: 'rate_limited'; retryAt: number } | { kind: 'error'; message: string };

export type ChatState = {
  status: 'idle' | 'waiting' | 'streaming' | 'done' | 'failed';
  question: string;
  /** The model's text while streaming, the server's validated answer once `citations` is set. */
  text: string;
  /** `null` until the `citations` event: markers stay plain text until then. */
  citations: ChatCitation[] | null;
  refused: boolean;
  truncated: boolean;
  failure: ChatFailure | null;
  traceId: string | null;
  /** The trace is written after `done`, before the stream closes (OBSERVABILITY.md §1). */
  isStreamClosed: boolean;
};

export type ChatAction =
  | { type: 'submit'; question: string }
  | { type: 'event'; event: ChatEvent }
  | { type: 'fail'; failure: ChatFailure }
  | { type: 'stream_closed' };

export const INITIAL_CHAT_STATE: ChatState = {
  status: 'idle',
  question: '',
  text: '',
  citations: null,
  refused: false,
  truncated: false,
  failure: null,
  traceId: null,
  isStreamClosed: false,
};

export const CONNECTION_LOST = 'The connection was lost before the answer finished. Try again.';
export const NETWORK_ERROR = 'Could not reach the server. Try again.';
const UNKNOWN_ERROR = 'Something went wrong.';

const REFUSAL_MARKER = 'NO_ANSWER:';

// A failed answer never got its citations checked, so its partial text does not stay on screen.
function fail(state: ChatState, failure: ChatFailure): ChatState {
  return { ...state, status: 'failed', text: '', citations: null, failure };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'submit':
      return { ...INITIAL_CHAT_STATE, status: 'waiting', question: action.question };
    case 'fail':
      return fail(state, action.failure);
    case 'stream_closed':
      return { ...state, isStreamClosed: true };
    case 'event': {
      const { event } = action;
      switch (event.event) {
        case 'meta':
          return { ...state, traceId: event.data.traceId };
        case 'delta':
          return { ...state, status: 'streaming', text: state.text + event.data.text };
        case 'citations':
          return { ...state, text: event.data.text, citations: event.data.valid };
        case 'done':
          return {
            ...state,
            status: 'done',
            refused: event.data.refused,
            truncated: event.data.truncated,
          };
        case 'error':
          return fail(state, { kind: 'error', message: event.data.message });
      }
    }
  }
}

/**
 * The text to show now. `citations.text` has no refusal marker, but the deltas before it do, so the
 * marker (or the start of it, split across deltas) is hidden while streaming.
 */
export function visibleText({ text, citations }: Pick<ChatState, 'text' | 'citations'>): string {
  if (citations) return text;
  const trimmed = text.trimStart();
  if (REFUSAL_MARKER.startsWith(trimmed)) return '';
  return trimmed.startsWith(REFUSAL_MARKER)
    ? trimmed.slice(REFUSAL_MARKER.length).trimStart()
    : text;
}

/** Rate-limit windows are whole UTC hours (`windowStart` in guardrails/rateLimit.ts). */
export function nextRateLimitWindow(now: number): number {
  const hourMs = 60 * 60 * 1000;
  return (Math.floor(now / hourMs) + 1) * hourMs;
}

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Maps a JSON error response of `/api/chat`; the body may be anything if a proxy answered. */
export function failureFromResponse(status: number, body: unknown, now: number): ChatFailure {
  if (status === 429) return { kind: 'rate_limited', retryAt: nextRateLimitWindow(now) };
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return { kind: 'error', message: typeof message === 'string' ? message : UNKNOWN_ERROR };
}
