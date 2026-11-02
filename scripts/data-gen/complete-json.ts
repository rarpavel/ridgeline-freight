import { z } from 'zod';

import { env } from '@/env';
import { openai } from '@/server/llm/client';

// Calls the data-gen model with a strict JSON schema derived from `schema`, returns the parsed JSON.
export async function completeJson(
  prompt: string,
  name: string,
  schema: z.ZodType,
  maxCompletionTokens: number,
): Promise<unknown> {
  // Drops the "$schema" key that zod emits, since response_format only needs the schema itself.
  const jsonSchema: Record<string, unknown> = z.toJSONSchema(schema);
  delete jsonSchema.$schema;

  const response = await openai.chat.completions.create({
    model: env.DATAGEN_MODEL,
    max_completion_tokens: maxCompletionTokens,
    messages: [{ role: 'user', content: prompt }],
    response_format: {
      type: 'json_schema',
      json_schema: { name, strict: true, schema: jsonSchema },
    },
  });
  const choice = response.choices[0];
  if (!choice?.message.content) {
    throw new Error(`Model returned no content, finish reason: ${choice?.finish_reason ?? 'none'}`);
  }
  return JSON.parse(choice.message.content);
}
