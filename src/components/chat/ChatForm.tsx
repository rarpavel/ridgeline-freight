'use client';

import type { FormEvent, KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export function ChatForm({
  value,
  maxChars,
  isBusy,
  onChange,
  onSubmit,
}: {
  value: string;
  maxChars: number;
  isBusy: boolean;
  onChange: (value: string) => void;
  onSubmit: (question: string) => void;
}) {
  // The server trims before it checks the length, so the counter does too.
  const question = value.trim();
  const isTooLong = question.length > maxChars;
  const canSubmit = !isBusy && question.length > 0 && !isTooLong;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSubmit) onSubmit(question);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <label htmlFor="chat-question" className="sr-only">
        Your question
      </label>
      <Textarea
        id="chat-question"
        name="question"
        rows={2}
        placeholder="Ask about contracts, rates, SOPs or HR policies…"
        className="max-h-40 resize-none"
        value={value}
        aria-invalid={isTooLong}
        aria-describedby="chat-question-count"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center justify-between gap-3">
        <p
          id="chat-question-count"
          className={cn(
            'text-xs tabular-nums',
            isTooLong ? 'text-destructive font-medium' : 'text-muted-foreground',
          )}
        >
          {question.length}/{maxChars}
          {isTooLong && ' — shorten your question to send it'}
        </p>
        <Button type="submit" disabled={!canSubmit}>
          {isBusy ? 'Answering…' : 'Ask'}
        </Button>
      </div>
    </form>
  );
}
