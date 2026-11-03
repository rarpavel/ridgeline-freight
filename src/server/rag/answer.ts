import 'server-only';

import { randomUUID } from 'node:crypto';

import { env } from '@/env';
import { AppError } from '@/lib/errors';
import type { ChatCitation, ChatErrorCode, ChatEvent } from '@/lib/sse';
import type { SessionUser } from '@/server/auth/require';
import { costOf, type ModelUsage } from '@/server/llm/pricing';
import { logger } from '@/server/logger';

import { validateCitations } from './citations';
import { refuseWithoutLlm } from './gate';
import { generate, type StreamChat, type TokenUsage } from './generate';
import { buildMessages, RAG_SYSTEM_PROMPT_VERSION } from './prompt';
import { REFUSAL_TEXT } from './refusal';
import { loadPromptChunks, retrieve, type EmbedQuery, type RetrieveDeps } from './retrieve';
import { toTraceRetrieval, writeTrace, type RequestTrace } from './trace';

export type AnswerDeps = RetrieveDeps & {
  embed: EmbedQuery;
  llm: StreamChat;
  signal: AbortSignal;
  llmTimeoutMs?: number;
};

const ROUTE = '/api/chat';
const CLIENT_DISCONNECTED = 'client_disconnected';

const ERROR_MESSAGES: Record<ChatErrorCode, string> = {
  llm_error: 'The model is unavailable, please retry.',
  db_error: 'The document store is waking up, retry in a few seconds.',
  internal: 'Something went wrong.',
};

/** What `chat.done` adds to the common fields (OBSERVABILITY.md §2): no question, no answer. */
function doneLogFields({
  gate,
  refused,
  refusalReason,
  inputTokens,
  outputTokens,
  costUsd,
  ttftMs,
  citationsValid,
  citationsDropped,
}: RequestTrace) {
  return {
    gate,
    refused,
    reason: refusalReason,
    inputTokens,
    outputTokens,
    costUsd,
    ttftMs,
    citationsValid,
    citationsDropped,
  };
}

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
  const logFields = { traceId, route: ROUTE, account: user.account, role: user.role };
  // Filled in as the request advances, so whatever ends it leaves a trace of how far it got. `gate`
  // stays 'answer' when retrieval itself fails: nothing refused the question.
  const trace: RequestTrace = {
    id: traceId,
    source: 'chat',
    account: user.account,
    role: user.role,
    question,
    gate: 'answer',
    retrieval: {
      candidates: [],
      bestSim: null,
      simFloor: env.SIM_FLOOR,
      ftsMatches: 0,
      ftsAllTermsMatches: 0,
      vectorUnavailable: false,
    },
  };
  let finished = false;

  try {
    const result = await retrieve({ question, roles }, { db, embed });
    const { candidates, bestSim, ftsAllTermsMatches, embeddingTokens } = result;
    const retrieval = toTraceRetrieval(result, env.SIM_FLOOR);
    trace.retrieval = retrieval;
    const embeddingUsage: ModelUsage[] = [];
    if (embeddingTokens !== null) {
      trace.embeddingModel = env.EMBEDDING_MODEL;
      embeddingUsage.push({
        model: env.EMBEDDING_MODEL,
        inputTokens: embeddingTokens,
        outputTokens: 0,
      });
    }
    // Stays the embedding's alone if the model stream never finishes and so reports no usage.
    trace.costUsd = costOf(embeddingUsage);
    const metaData = {
      traceId,
      promptVersion: RAG_SYSTEM_PROMPT_VERSION,
      model: env.CHAT_MODEL,
    };

    if (refuseWithoutLlm({ bestSim, ftsAllTermsMatches }, env.SIM_FLOOR)) {
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      trace.gate = 'refuse_gate';
      trace.refused = true;
      trace.refusalReason = 'gate';
      // Fusion marked the ones that would fit a prompt, but no prompt is built.
      for (const candidate of retrieval.candidates) candidate.inPrompt = false;
      yield { event: 'meta', data: { ...metaData, gate: 'refuse' } };
      yield { event: 'delta', data: { text: REFUSAL_TEXT } };
      yield { event: 'citations', data: { valid: [], dropped: [], text: REFUSAL_TEXT } };

      const latencyMs = Date.now() - startedAt;
      trace.latencyMs = latencyMs;
      finished = true;
      logger.info({ ...logFields, ...doneLogFields(trace), durationMs: latencyMs }, 'chat.done');
      yield {
        event: 'done',
        data: {
          refused: true,
          reason: 'gate',
          usage,
          ttftMs: null,
          latencyMs,
          costUsd: trace.costUsd,
        },
      };
      return;
    }

    const chunkIds = candidates.filter(({ inPrompt }) => inPrompt).map(({ chunkId }) => chunkId);
    const chunks = await loadPromptChunks({ chunkIds, roles }, { db });

    trace.promptVersion = RAG_SYSTEM_PROMPT_VERSION;
    trace.model = env.CHAT_MODEL;
    yield { event: 'meta', data: { ...metaData, gate: 'answer' } };

    const messages = buildMessages({ role: user.role, today: new Date(), chunks, question });
    let answer = '';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let ttftMs: number | null = null;
    for await (const part of generate(messages, { llm, signal, timeoutMs: llmTimeoutMs })) {
      if (part.type === 'usage') {
        usage = part.usage;
        trace.inputTokens = usage.inputTokens;
        trace.outputTokens = usage.outputTokens;
        trace.costUsd = costOf([...embeddingUsage, { model: env.CHAT_MODEL, ...usage }]);
        continue;
      }
      ttftMs ??= Date.now() - startedAt;
      trace.ttftMs = ttftMs;
      answer += part.text;
      trace.generatedText = answer;
      yield { event: 'delta', data: { text: part.text } };
    }

    // `originalText` stays out of the logs like the prompt; the trace has it as `generatedText`.
    const { text, refused, reason, valid, dropped } = validateCitations(answer, chunks.length);
    if (dropped.length > 0) logger.warn({ ...logFields, dropped }, 'chat.citations_dropped');

    const citations = valid.flatMap((n): ChatCitation[] => {
      const chunk = chunks[n - 1];
      if (!chunk) return [];
      const { chunkId, documentId, documentTitle: title, sectionRef } = chunk;
      return [{ n, chunkId, documentId, title, sectionRef }];
    });
    const citedChunkIds = new Set(citations.map(({ chunkId }) => chunkId));
    for (const candidate of retrieval.candidates) {
      candidate.cited = citedChunkIds.has(candidate.chunkId);
    }
    trace.refused = refused;
    trace.refusalReason = reason;
    trace.citationsValid = citations.length;
    trace.citationsDropped = dropped.length;
    yield { event: 'citations', data: { valid: citations, dropped, text } };

    const latencyMs = Date.now() - startedAt;
    trace.latencyMs = latencyMs;
    finished = true;
    logger.info({ ...logFields, ...doneLogFields(trace), durationMs: latencyMs }, 'chat.done');
    yield {
      event: 'done',
      data: { refused, reason, usage, ttftMs, latencyMs, costUsd: trace.costUsd ?? null },
    };
  } catch (err) {
    // An aborted request is not a failure; the finally block records it.
    if (signal.aborted) return;
    const code = errorCode(err);
    trace.error = code;
    logger.error({ ...logFields, err, code, durationMs: Date.now() - startedAt }, 'chat.error');
    yield { event: 'error', data: { code, message: ERROR_MESSAGES[code] } };
  } finally {
    // Runs on every exit, also when the client cancels while this generator waits at a `yield`,
    // where the catch block never runs. Awaited here, so the stream stays open until it is written.
    trace.latencyMs ??= Date.now() - startedAt;
    if (!finished && !trace.error) {
      trace.error = CLIENT_DISCONNECTED;
      logger.info({ ...logFields, durationMs: trace.latencyMs }, 'chat.client_disconnected');
    }
    await writeTrace(trace, { db });
  }
}
