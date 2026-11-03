'use client';

import { useEffect, useReducer, useRef, useState } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import {
  chatReducer,
  CONNECTION_LOST,
  failureFromResponse,
  INITIAL_CHAT_STATE,
  NETWORK_ERROR,
  visibleText,
} from '@/lib/chat-state';
import { parseSseStream } from '@/lib/sse';

import { AnswerText } from './AnswerText';
import { ChatBanner } from './ChatBanner';
import { ChatForm } from './ChatForm';

export function ChatPanel({ maxQuestionChars }: { maxQuestionChars: number }) {
  const [state, dispatch] = useReducer(chatReducer, INITIAL_CHAT_STATE);
  const [draft, setDraft] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the page cancels the stream, and the route stops the model call with it.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function ask(question: string) {
    const abort = new AbortController();
    abortRef.current = abort;
    setDraft('');
    dispatch({ type: 'submit', question });

    let isStreaming = false;
    let isFinished = false;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
        signal: abort.signal,
      });
      if (response.status === 401) {
        window.location.assign('/login?next=/chat');
        return;
      }
      if (!response.ok || !response.body) {
        const body: unknown = await response.json().catch(() => null);
        const failure = failureFromResponse(response.status, body, Date.now());
        dispatch({ type: 'fail', failure });
        setDraft(question);
        return;
      }
      isStreaming = true;
      for await (const event of parseSseStream(response.body)) {
        dispatch({ type: 'event', event });
        if (event.event === 'error') setDraft(question);
        if (event.event === 'done' || event.event === 'error') isFinished = true;
      }
      if (!isFinished) {
        dispatch({ type: 'fail', failure: { kind: 'error', message: CONNECTION_LOST } });
        setDraft(question);
      }
    } catch {
      if (abort.signal.aborted || isFinished) return;
      const message = isStreaming ? CONNECTION_LOST : NETWORK_ERROR;
      dispatch({ type: 'fail', failure: { kind: 'error', message } });
      setDraft(question);
    }
  }

  const { status, question, citations, refused, failure } = state;
  const isBusy = status === 'waiting' || status === 'streaming';
  const text = visibleText(state);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex-1 px-4 py-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          {status === 'idle' && (
            <p className="text-muted-foreground text-sm">
              Ask one question at a time. Answers come only from the documents your role can access,
              with a citation for each fact.
            </p>
          )}

          {question && (
            <p className="bg-muted self-end rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap">
              {question}
            </p>
          )}

          <section aria-label="Answer" aria-live="polite" aria-busy={isBusy}>
            {isBusy && text === '' && (
              <div className="flex flex-col gap-2" data-testid="answer-loading">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            )}
            {status === 'done' && refused ? (
              <div
                className="bg-muted border-border text-muted-foreground rounded-md border px-3 py-2 text-sm"
                data-testid="answer-refusal"
              >
                <AnswerText text={text} citations={[]} />
              </div>
            ) : (
              text !== '' && <AnswerText text={text} citations={citations} />
            )}
          </section>

          {failure && <ChatBanner failure={failure} />}
        </div>
      </div>

      <div className="bg-background border-border sticky bottom-0 border-t px-4 py-3">
        <div className="mx-auto w-full max-w-2xl">
          <ChatForm
            value={draft}
            maxChars={maxQuestionChars}
            isBusy={isBusy}
            onChange={setDraft}
            onSubmit={(next) => void ask(next)}
          />
        </div>
      </div>
    </div>
  );
}
