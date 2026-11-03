import 'server-only';

import { logger } from '@/server/logger';

import pricing from '../../../config/pricing.json';

type ModelPrice = { inputPer1M: number; outputPer1M: number };

const PRICES: Record<string, ModelPrice> = pricing.models;

export const PRICING_AS_OF = pricing.asOf;

export type ModelUsage = { model: string; inputTokens: number; outputTokens: number };

/**
 * USD for these calls at list price, ignoring provider discounts such as cached input. `null` when
 * there is nothing to price or a model has no price: an unknown cost must not read as a low one.
 */
export function costOf(usages: readonly ModelUsage[]): number | null {
  if (usages.length === 0) return null;
  let total = 0;
  for (const { model, inputTokens, outputTokens } of usages) {
    const price = PRICES[model];
    if (!price) {
      logger.warn({ model }, 'pricing.unknown_model');
      return null;
    }
    total += (inputTokens / 1e6) * price.inputPer1M + (outputTokens / 1e6) * price.outputPer1M;
  }
  return total;
}
