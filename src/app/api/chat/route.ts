import { z } from 'zod';

import { env } from '@/env';
import { AppError } from '@/lib/errors';
import { encodeSseEvent, type ChatEvent } from '@/lib/sse';
import { requireSession } from '@/server/auth/require';
import { db } from '@/server/db/client';
import { assertDailyBudget, recordDailyUsage } from '@/server/guardrails/budget';
import { clientIp } from '@/server/guardrails/limits';
import { assertChatRateLimit } from '@/server/guardrails/rateLimit';
import { errorResponse } from '@/server/http';
import { embedQuery } from '@/server/llm/embeddings';
import { answerQuestion } from '@/server/rag/answer';
import { streamChat } from '@/server/rag/generate';

const ROUTE = '/api/chat';

// Covers the embedding call, the retrieval queries and the 30 s model timeout.
export const maxDuration = 60;

const bodySchema = z.object({
  question: z.string().trim().min(1).max(env.MAX_QUESTION_CHARS),
});

async function parseBody(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const result = bodySchema.safeParse(body);
  if (!result.success) {
    throw new AppError(
      'validation',
      `Enter a question of at most ${env.MAX_QUESTION_CHARS} characters.`,
    );
  }
  return result.data;
}

function toSseStream(events: AsyncGenerator<ChatEvent>, abort: AbortController) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await events.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(encodeSseEvent(value)));
    },
    // The client went away: stop paying for tokens nobody reads.
    async cancel() {
      abort.abort();
      await events.return(undefined);
    },
  });
}

export async function POST(request: Request) {
  try {
    const user = await requireSession();
    const { question } = await parseBody(request);
    await assertChatRateLimit({ account: user.account, ip: clientIp(request) }, { db });
    await assertDailyBudget({ db });

    const abort = new AbortController();
    const events = answerQuestion(
      { question, user },
      {
        db,
        embed: embedQuery,
        llm: streamChat,
        signal: abort.signal,
        recordUsage: (usage) => recordDailyUsage(usage, { db }),
      },
    );
    return new Response(toSseStream(events, abort), {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    return errorResponse(err, ROUTE);
  }
}
