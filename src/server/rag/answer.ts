import 'server-only';

import { randomUUID } from 'node:crypto';

import { env } from '@/env';
import { AppError } from '@/lib/errors';
import type { ChatCitation, ChatErrorCode, ChatEvent } from '@/lib/sse';
import type { SessionUser } from '@/server/auth/require';
import { logger } from '@/server/logger';

import { validateCitations } from './citations';
import { refuseWithoutLlm } from './gate';
import { generate, type StreamChat, type TokenUsage } from './generate';
import { buildMessages, RAG_SYSTEM_PROMPT_VERSION } from './prompt';
import { REFUSAL_TEXT } from './refusal';
import { loadPromptChunks, retrieve, type RetrieveDeps } from './retrieve';

export type AnswerDeps = RetrieveDeps & {
  embed: (texts: string[]) => Promise<number[][]>;
  llm: StreamChat;
  signal: AbortSignal;
  llmTimeoutMs?: number;
};

const ERROR_MESSAGES: Record<ChatErrorCode, string> = {
  llm_error: 'The model is unavailable, please retry.',
  db_error: 'The document store is waking up, retry in a few seconds.',
  internal: 'Something went wrong.',
};

function errorCode(err: unknown): ChatErrorCode {
  if (err instanceof AppError && (err.code === 'llm_error' || err.code === 'db_error')) {
    return err.code;
  }
  return 'internal';
}

/**
 * One question to one answer, as the events of ARCHITECTURE.md §2.2. Never throws: once the stream
 * has started, a failure can only reach the client as a final `error` event (CONVENTIONS.md §4).
 */
export async function* answerQuestion(
  { question, user }: { question: string; user: SessionUser },
  { db, embed, llm, signal, llmTimeoutMs }: AnswerDeps,
): AsyncGenerator<ChatEvent, void, undefined> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const roles = [user.role];
  const logFields = { traceId, account: user.account, role: user.role };

  try {
    const { candidates, bestSim, ftsMatches } = await retrieve({ question, roles }, { db, embed });
    const metaData = {
      traceId,
      promptVersion: RAG_SYSTEM_PROMPT_VERSION,
      model: env.CHAT_MODEL,
    };

    if (refuseWithoutLlm({ bestSim, ftsMatches }, env.SIM_FLOOR)) {
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      yield { event: 'meta', data: { ...metaData, gate: 'refuse' } };
      yield { event: 'delta', data: { text: REFUSAL_TEXT } };
      yield { event: 'citations', data: { valid: [], dropped: [], text: REFUSAL_TEXT } };

      const latencyMs = Date.now() - startedAt;
      yield {
        event: 'done',
        data: { refused: true, reason: 'gate', usage, ttftMs: null, latencyMs, costUsd: null },
      };
      logger.info(
        { ...logFields, gate: 'refuse', refused: true, reason: 'gate', durationMs: latencyMs },
        'chat.done',
      );
      return;
    }

    const chunkIds = candidates.filter(({ inPrompt }) => inPrompt).map(({ chunkId }) => chunkId);
    const chunks = await loadPromptChunks({ chunkIds, roles }, { db });

    yield { event: 'meta', data: { ...metaData, gate: 'answer' } };

    const messages = buildMessages({ role: user.role, today: new Date(), chunks, question });
    let answer = '';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let ttftMs: number | null = null;
    for await (const part of generate(messages, { llm, signal, timeoutMs: llmTimeoutMs })) {
      if (part.type === 'usage') {
        usage = part.usage;
        continue;
      }
      ttftMs ??= Date.now() - startedAt;
      answer += part.text;
      yield { event: 'delta', data: { text: part.text } };
    }

    // `originalText` goes into the trace with RAG-027; it stays out of the logs like the prompt.
    const { text, refused, reason, valid, dropped } = validateCitations(answer, chunks.length);
    if (dropped.length > 0) logger.warn({ ...logFields, dropped }, 'chat.citations_dropped');

    const citations = valid.flatMap((n): ChatCitation[] => {
      const chunk = chunks[n - 1];
      if (!chunk) return [];
      const { chunkId, documentId, documentTitle: title, sectionRef } = chunk;
      return [{ n, chunkId, documentId, title, sectionRef }];
    });
    yield { event: 'citations', data: { valid: citations, dropped, text } };

    const latencyMs = Date.now() - startedAt;
    // Cost comes with pricing.json in RAG-027.
    yield { event: 'done', data: { refused, reason, usage, ttftMs, latencyMs, costUsd: null } };
    logger.info(
      { ...logFields, gate: 'answer', refused, reason, ...usage, ttftMs, durationMs: latencyMs },
      'chat.done',
    );
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (signal.aborted) {
      logger.info({ ...logFields, durationMs }, 'chat.client_disconnected');
      return;
    }
    const code = errorCode(err);
    logger.error({ ...logFields, err, code, durationMs }, 'chat.error');
    yield { event: 'error', data: { code, message: ERROR_MESSAGES[code] } };
  }
}
