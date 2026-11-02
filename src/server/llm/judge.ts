import 'server-only';

import Anthropic from '@anthropic-ai/sdk';

import { env } from '@/env';
import { AppError } from '@/lib/errors';

// The SDK retries 408, 409, 429, 5xx and connection errors with exponential backoff.
const MAX_RETRIES = 3;
const DEFAULT_MAX_TOKENS = 800;

type CompleteOptions = {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
};

let client: Anthropic | undefined;

// Created on first use: the key is optional in env because only the CLIs need this provider.
function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError('llm_error', 'ANTHROPIC_API_KEY is not set');
  }
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: MAX_RETRIES });
  return client;
}

export async function completeWithClaude(options: CompleteOptions): Promise<string> {
  const response = await getClient().messages.create({
    model: options.model ?? env.JUDGE_MODEL,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(options.system ? { system: options.system } : {}),
    messages: [{ role: 'user', content: options.prompt }],
  });

  // A cut-off or refused reply is not usable output, so it must not reach a JSON parser as text.
  if (response.stop_reason === 'max_tokens' || response.stop_reason === 'refusal') {
    throw new AppError('llm_error', `Claude stopped early: ${response.stop_reason}`);
  }

  return response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}
