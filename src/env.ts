import 'server-only';

import { z } from 'zod';

const demoAccountSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['sales', 'hr', 'ops', 'admin']),
  // A bad value must stop the boot: Next.js expands an unescaped $ in .env.local into a shorter
  // string, which would otherwise only show up later as every login failing.
  passwordHash: z
    .string()
    .regex(
      /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/,
      'must be a bcrypt hash (pnpm hash-password); in .env.local write every $ as \\$',
    ),
  // Shown on the login page: demo credentials are public by design (ADR-0016).
  demoPassword: z.string().min(1).optional(),
});

const demoAccountsSchema = z
  .string()
  .transform((value, ctx): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
      return z.NEVER;
    }
  })
  .pipe(z.array(demoAccountSchema).min(1));

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

export const envSchema = z.object({
  DATABASE_URL: postgresUrl,
  DATABASE_URL_DIRECT: postgresUrl.optional(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  CHAT_MODEL: z.string().default('gpt-5-mini'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  SESSION_SECRET: z.string().min(32),
  DEMO_ACCOUNTS_JSON: demoAccountsSchema,
  SIM_FLOOR: z.coerce.number().min(0).max(1).default(0.3),
  MAX_QUESTION_CHARS: z.coerce.number().int().positive().default(500),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(700),
  RATE_LIMIT_ACCOUNT_PER_HOUR: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_IP_PER_HOUR: z.coerce.number().int().positive().default(40),
  DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(400000),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  JUDGE_MODEL: z.string().default('claude-haiku-5-5'),
  DATAGEN_MODEL: z.string().default('gpt-5-mini'),
  DATAGEN_QUESTIONS_MODEL: z.string().default('claude-haiku-5-5'),
  NEXT_PUBLIC_APP_ENV: z.enum(['local', 'production']).default('local'),
});

function parseEnv(source: NodeJS.ProcessEnv) {
  // An empty value in .env.local (`KEY=`) means "not set", so defaults and required checks apply.
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(present);
  if (result.success) return result.data;

  // Built from variable names and schema messages only, so rejected values never reach the logs.
  const problems = result.error.issues.map((issue) => {
    const name = String(issue.path[0]);
    const reason = present[name] === undefined ? 'missing' : issue.message;
    return `  ${issue.path.join('.')}: ${reason}`;
  });
  throw new Error(`Invalid environment variables:\n${problems.join('\n')}`);
}

export const env = parseEnv(process.env);
