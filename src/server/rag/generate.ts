import 'server-only';

import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import type OpenAI from 'openai';

import { env } from '@/env';
import { AppError } from '@/lib/errors';
import { openai } from '@/server/llm/client';

import type { PromptMessages } from './prompt';

const LLM_TIMEOUT_MS = 30_000;

export type TokenUsage = { inputTokens: number; outputTokens: number };

export type GenerationPart =
  { type: 'delta'; text: string } | { type: 'end'; usage: TokenUsage; truncated: boolean };

export type StreamChat = (
  messages: PromptMessages,
  signal: AbortSignal,
) => Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;

export const streamChat: StreamChat = (messages, signal) =>
  openai.chat.completions.create(
    {
      model: env.CHAT_MODEL,
      messages,
      // gpt-5 models reject the older max_tokens name.
      max_completion_tokens: env.MAX_OUTPUT_TOKENS,
      // Reasoning tokens count against that limit (ADR-0022).
      reasoning_effort: env.REASONING_EFFORT,
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal },
  );

// Built on first use: only a stream that ends without a usage chunk needs it.
let encoder: Tiktoken | undefined;

function countTokens(text: string): number {
  encoder ??= new Tiktoken(o200kBase);
  return encoder.encode(text, [], []).length;
}

function estimateUsage(messages: PromptMessages, answer: string): TokenUsage {
  return {
    inputTokens: messages.reduce((sum, { content }) => sum + countTokens(content), 0),
    outputTokens: countTokens(answer),
  };
}

/**
 * Yields the answer's text as it arrives, then its token usage and whether the output limit cut it
 * off (RAG_PIPELINE.md §2.5).
 */
export async function* generate(
  messages: PromptMessages,
  {
    llm,
    signal,
    timeoutMs = LLM_TIMEOUT_MS,
  }: { llm: StreamChat; signal: AbortSignal; timeoutMs?: number },
): AsyncGenerator<GenerationPart, void, undefined> {
  let answer = '';
  let usage: TokenUsage | null = null;
  let truncated = false;
  try {
    const stream = await llm(messages, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta.content;
      if (chunk.choices[0]?.finish_reason === 'length') truncated = true;
      if (text) {
        answer += text;
        yield { type: 'delta', text };
      }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      }
    }
  } catch (err) {
    throw new AppError('llm_error', 'Chat completion failed', { cause: err });
  }
  yield { type: 'end', usage: usage ?? estimateUsage(messages, answer), truncated };
}
