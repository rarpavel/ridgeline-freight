import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// Provider error messages can echo part of the API key, so only the status is printed for them.
export function describeError(err: unknown): string {
  if (err instanceof OpenAI.APIError) return `OpenAI API error, status ${err.status}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API error, status ${err.status}`;
  return err instanceof Error ? err.message : String(err);
}
