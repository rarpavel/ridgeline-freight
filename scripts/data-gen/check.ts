import './load-env';

import { z } from 'zod';

import { env } from '@/env';
import { openai } from '@/server/llm/client';
import { completeWithClaude } from '@/server/llm/judge';
import { formatPromptVersion, loadPrompt } from '@/server/prompts/load';

import { describeError } from './describe-error';
import { stripCodeFence } from './text-checks';

const PROMPT = 'Reply with JSON only, with no other text: {"ok": true}';
// Leaves room for reasoning tokens, which count against the limit on gpt-5 models.
const OPENAI_MAX_TOKENS = 800;

const replySchema = z.object({ ok: z.literal(true) });

function parseReply(text: string): void {
  replySchema.parse(JSON.parse(stripCodeFence(text)));
}

async function checkOpenAi(): Promise<void> {
  const response = await openai.chat.completions.create({
    model: env.DATAGEN_MODEL,
    max_completion_tokens: OPENAI_MAX_TOKENS,
    messages: [{ role: 'user', content: PROMPT }],
  });
  parseReply(response.choices[0]?.message.content ?? '');
  console.log(`openai ok (${env.DATAGEN_MODEL})`);
}

async function checkAnthropic(): Promise<void> {
  parseReply(await completeWithClaude({ prompt: PROMPT, model: env.DATAGEN_QUESTIONS_MODEL }));
  console.log(`anthropic ok (${env.DATAGEN_QUESTIONS_MODEL})`);
}

async function main(): Promise<void> {
  await checkOpenAi();
  await checkAnthropic();
  console.log(formatPromptVersion(loadPrompt('rag-system', 3)));
}

main().catch((err: unknown) => {
  console.error(describeError(err));
  process.exit(1);
});
