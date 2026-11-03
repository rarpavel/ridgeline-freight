// No "server-only" here: drizzle-kit loads schema files outside Next.js, and they hold no secrets.
import {
  bigint,
  date,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.key, table.windowStart] })],
);

export const usageDaily = pgTable('usage_daily', {
  day: date('day', { mode: 'string' }).primaryKey(),
  requests: integer('requests').notNull().default(0),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  // The same scale as request_traces.cost_usd: a coarser one would round each small addition away.
  costUsd: numeric('cost_usd', { precision: 10, scale: 6, mode: 'number' }).notNull().default(0),
});
