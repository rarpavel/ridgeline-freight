import 'server-only';

import OpenAI from 'openai';

import { env } from '@/env';

// The SDK retries 408, 409, 429, 5xx and connection errors with exponential backoff.
const MAX_RETRIES = 3;

export const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  baseURL: env.OPENAI_BASE_URL,
  maxRetries: MAX_RETRIES,
});
