import 'server-only';

import { readFileSync } from 'node:fs';

import { and, eq } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';

import { env } from '@/env';
import type { ChatCitation, ChatEvent } from '@/lib/sse';
import type { Role } from '@/server/auth/session';
import type { db as appDb } from '@/server/db/client';
import { documents } from '@/server/db/schema/documents';
import {
  evalQuestions,
  evalResults,
  evalRuns,
  type RetrievalConfig,
} from '@/server/db/schema/eval';
import { requestTraces } from '@/server/db/schema/request-traces';
import { answerQuestion } from '@/server/rag/answer';
import { DEFAULT_FUSE_OPTIONS } from '@/server/rag/fuse';
import type { StreamChat } from '@/server/rag/generate';
import { formatBody, RAG_SYSTEM_PROMPT_VERSION } from '@/server/rag/prompt';
import { FTS_TOP_K, loadPromptChunks, VECTOR_TOP_K, type EmbedQuery } from '@/server/rag/retrieve';

import { importEvalQuestions } from './import-questions';
import {
  judgeResult,
  type CitedPassage,
  type CompleteJudge,
  type JudgeFact,
  type JudgeVerdict,
} from './judge-runner';
import { aggregateMetrics, scoreResult, type Category, type RunMetrics } from './metrics';

const CONCURRENCY = 2;
const EVAL_ACCOUNT = 'eval';

export type Split = 'dev' | 'test';

export type RunEvalInput =
  { split: Split; label?: string; simFloor?: number } | { resumeRunId: string };

export type EvalJudge = {
  complete: CompleteJudge;
  model: string;
  factsById: ReadonlyMap<string, JudgeFact>;
};

export type RunEvalDeps = {
  db: typeof appDb;
  embed: EmbedQuery;
  llm: StreamChat;
  /** Absent with `--no-judge`: the run records deterministic metrics only. */
  judge?: EvalJudge;
  signal: AbortSignal;
  gitSha: string;
  datasetVersion: string;
  questionsPath: string;
};

export type EvalFailure = { slug: string; reason: string };

export type RunEvalResult = {
  runId: string;
  total: number;
  skipped: number;
  failures: EvalFailure[];
  /** Null until every question has a result; `--resume` finishes the run. */
  metrics: RunMetrics | null;
};

type Question = typeof evalQuestions.$inferSelect;
type Run = Pick<typeof evalRuns.$inferSelect, 'id' | 'split' | 'retrievalConfig'>;
type AccessRoles = ReadonlyMap<string, readonly string[]>;

function currentRunConfig({ judge }: RunEvalDeps) {
  return {
    model: env.CHAT_MODEL,
    embeddingModel: env.EMBEDDING_MODEL,
    judgeModel: judge?.model ?? null,
    promptVersion: RAG_SYSTEM_PROMPT_VERSION,
  };
}

async function startRun(
  { split, label, simFloor }: { split: Split; label?: string; simFloor?: number },
  deps: RunEvalDeps,
): Promise<Run> {
  const { db, gitSha, datasetVersion } = deps;
  const retrievalConfig: RetrievalConfig = {
    ...DEFAULT_FUSE_OPTIONS,
    vectorTopK: VECTOR_TOP_K,
    ftsTopK: FTS_TOP_K,
    simFloor: simFloor ?? env.SIM_FLOOR,
  };
  const [run] = await db
    .insert(evalRuns)
    .values({ label, split, ...currentRunConfig(deps), retrievalConfig, gitSha, datasetVersion })
    .returning();
  if (!run) throw new Error('Could not create the eval run');
  return run;
}

/** Results from different code, models, prompts or datasets would not describe one system. */
async function loadRunToResume(runId: string, deps: RunEvalDeps): Promise<Run> {
  const { db, gitSha, datasetVersion } = deps;
  const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, runId));
  if (!run) throw new Error(`Eval run ${runId} not found`);
  if (run.finishedAt) throw new Error(`Eval run ${runId} is already finished`);

  const expected = { ...currentRunConfig(deps), gitSha, datasetVersion };
  for (const [name, value] of Object.entries(expected)) {
    const stored = run[name as keyof typeof expected];
    if (stored !== value) {
      throw new Error(`Cannot resume run ${runId}: ${name} was ${stored}, it is now ${value}`);
    }
  }
  return run;
}

/** Imports only when this dataset version has none, so a run reads what the database holds. */
async function loadQuestions(
  split: string,
  { db, datasetVersion, questionsPath }: RunEvalDeps,
): Promise<Question[]> {
  const read = () =>
    db
      .select()
      .from(evalQuestions)
      .where(
        and(
          eq(evalQuestions.split, split),
          eq(evalQuestions.reviewed, true),
          eq(evalQuestions.datasetVersion, datasetVersion),
        ),
      );

  const existing = await read();
  if (existing.length > 0) return existing;

  const raw: unknown = JSON.parse(readFileSync(questionsPath, 'utf8'));
  await importEvalQuestions(raw, { db, datasetVersion });
  const imported = await read();
  if (imported.length === 0) throw new Error(`No reviewed questions in split ${split}`);
  return imported;
}

/**
 * Who may read what, unfiltered on purpose: this is the evaluator's ground truth for leaks and holds
 * no document text. Fails on an unknown expected document before any model call is paid for.
 */
async function loadAccessRoles(
  questions: readonly Question[],
  { db }: RunEvalDeps,
): Promise<AccessRoles> {
  const rows = await db
    .select({ slug: documents.slug, accessRoles: documents.accessRoles })
    .from(documents);
  const accessRolesBySlug = new Map(rows.map(({ slug, accessRoles }) => [slug, accessRoles]));

  const missing = new Set(
    questions.flatMap(({ expectedDocSlugs }) =>
      expectedDocSlugs.filter((slug) => !accessRolesBySlug.has(slug)),
    ),
  );
  if (missing.size > 0) {
    throw new Error(`Expected documents not ingested: ${[...missing].join(', ')}`);
  }
  return accessRolesBySlug;
}

/** Before the run, like the documents above: a judge without its facts would grade against nothing. */
function checkFacts(questions: readonly Question[], { judge }: RunEvalDeps): void {
  if (!judge) return;
  const missing = new Set(
    questions.flatMap(({ sourceFactIds }) =>
      sourceFactIds.filter((factId) => !judge.factsById.has(factId)),
    ),
  );
  if (missing.size > 0)
    throw new Error(`Source facts not in the registry: ${[...missing].join(', ')}`);
}

/** The text the model saw, read under the question's role (CLAUDE.md rule 1), in citation order. */
async function loadCitedPassages(
  citations: readonly ChatCitation[],
  role: Role,
  { db }: RunEvalDeps,
): Promise<CitedPassage[]> {
  const loaded = await loadPromptChunks(
    { chunkIds: citations.map(({ chunkId }) => chunkId), roles: [role] },
    { db },
  );
  const byId = new Map(loaded.map((chunk) => [chunk.chunkId, chunk]));
  return citations.flatMap(({ n, chunkId }) => {
    const chunk = byId.get(chunkId);
    if (!chunk) return [];
    const section = [chunk.sectionRef, chunk.sectionTitle].filter(Boolean).join(' ');
    return [{ n, document: chunk.documentTitle, section, text: formatBody(chunk) }];
  });
}

async function judgeQuestion(
  question: Question,
  { answer, refused, citations }: { answer: string; refused: boolean; citations: ChatCitation[] },
  judge: EvalJudge,
  deps: RunEvalDeps,
): Promise<JudgeVerdict> {
  const role = question.role as Role;
  const verdict = await judgeResult(
    {
      category: question.category as Category,
      question: question.question,
      role,
      expectedAnswer: question.expectedAnswer,
      facts: question.sourceFactIds.flatMap((factId) => judge.factsById.get(factId) ?? []),
      answer,
      refused,
      citedPassages: await loadCitedPassages(citations, role, deps),
    },
    { complete: judge.complete, signal: deps.signal },
  );
  // Ctrl-C reads as a judge error from here: this question goes back to `--resume` instead.
  if (deps.signal.aborted) throw new Error('interrupted');
  return verdict;
}

async function runQuestion(
  question: Question,
  { run, accessRolesBySlug }: { run: Run; accessRolesBySlug: AccessRoles },
  deps: RunEvalDeps,
): Promise<void> {
  const { db, embed, llm, judge, signal } = deps;
  let traceId: string | null = null;
  let answer = '';
  let citations: ChatCitation[] = [];
  let finished: Extract<ChatEvent, { event: 'done' }>['data'] | null = null;

  const events = answerQuestion(
    {
      question: question.question,
      user: { account: EVAL_ACCOUNT, role: question.role as Role },
    },
    { db, embed, llm, signal, source: 'eval', simFloor: run.retrievalConfig.simFloor },
  );
  for await (const event of events) {
    if (event.event === 'meta') traceId = event.data.traceId;
    if (event.event === 'citations') {
      answer = event.data.text;
      citations = event.data.valid;
    }
    if (event.event === 'done') finished = event.data;
    if (event.event === 'error') throw new Error(event.data.code);
  }
  if (!traceId || !finished) throw new Error('interrupted');

  // Retrieval only reaches the trace: the events a chat client reads don't carry candidates.
  const [trace] = await db
    .select({
      retrieval: requestTraces.retrieval,
      citationsValid: requestTraces.citationsValid,
      citationsDropped: requestTraces.citationsDropped,
    })
    .from(requestTraces)
    .where(eq(requestTraces.id, traceId));
  if (!trace) throw new Error('trace_not_written');

  const { refused, ttftMs, latencyMs, costUsd } = finished;
  const { candidates } = trace.retrieval;
  // Refusals too: the rubric scores them, and the check against the refusal flag needs them.
  const verdict = judge
    ? await judgeQuestion(question, { answer, refused, citations }, judge, deps)
    : null;
  await db
    .insert(evalResults)
    .values({
      runId: run.id,
      questionId: question.id,
      answer,
      refused,
      citedChunkIds: citations.map(({ chunkId }) => chunkId),
      retrieved: candidates,
      scores: {
        ...scoreResult(
          {
            category: question.category as Category,
            role: question.role,
            expectedDocSlugs: question.expectedDocSlugs,
          },
          {
            refused,
            candidates,
            citationsValid: trace.citationsValid,
            citationsDropped: trace.citationsDropped,
            accessRolesBySlug,
          },
        ),
        ...verdict?.scores,
      },
      judgeRationale: verdict?.rationale ?? null,
      ttftMs,
      latencyMs,
      costUsd,
      traceId,
    })
    .onConflictDoNothing();
}

function failureReason(err: unknown): string {
  // A failed query's own message carries its parameters, the answer among them.
  const cause = err instanceof DrizzleQueryError ? err.cause : err;
  return cause instanceof Error ? cause.message : String(cause);
}

/** One failed question doesn't cost the others; the run stays open for `--resume`. */
async function runPending(
  pending: readonly Question[],
  context: { run: Run; accessRolesBySlug: AccessRoles },
  deps: RunEvalDeps,
): Promise<EvalFailure[]> {
  const queue = [...pending];
  const failures: EvalFailure[] = [];

  const worker = async () => {
    while (!deps.signal.aborted) {
      const question = queue.shift();
      if (!question) return;
      try {
        await runQuestion(question, context, deps);
      } catch (err) {
        failures.push({ slug: question.slug, reason: failureReason(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return failures;
}

async function finishRun(runId: string, { db }: RunEvalDeps): Promise<RunMetrics> {
  const rows = await db
    .select({
      category: evalQuestions.category,
      refused: evalResults.refused,
      ttftMs: evalResults.ttftMs,
      latencyMs: evalResults.latencyMs,
      costUsd: evalResults.costUsd,
      scores: evalResults.scores,
    })
    .from(evalResults)
    .innerJoin(evalQuestions, eq(evalQuestions.id, evalResults.questionId))
    .where(eq(evalResults.runId, runId));

  const metrics = aggregateMetrics(
    rows.map((row) => ({ ...row, category: row.category as Category })),
  );
  await db.update(evalRuns).set({ finishedAt: new Date(), metrics }).where(eq(evalRuns.id, runId));
  return metrics;
}

/** EVALUATION.md §5: the same `answerQuestion` as `/api/chat`, so the numbers describe the product. */
export async function runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<RunEvalResult> {
  const target = 'resumeRunId' in input ? await loadRunToResume(input.resumeRunId, deps) : input;

  const questions = await loadQuestions(target.split, deps);
  const accessRolesBySlug = await loadAccessRoles(questions, deps);
  checkFacts(questions, deps);

  // Created only now, so a bad dataset leaves no empty run behind.
  const run = 'id' in target ? target : await startRun(target, deps);

  const done = await deps.db
    .select({ questionId: evalResults.questionId })
    .from(evalResults)
    .where(eq(evalResults.runId, run.id));
  const doneIds = new Set(done.map(({ questionId }) => questionId));
  const pending = questions.filter(({ id }) => !doneIds.has(id));

  const failures = await runPending(pending, { run, accessRolesBySlug }, deps);
  const complete = failures.length === 0 && !deps.signal.aborted;

  return {
    runId: run.id,
    total: questions.length,
    skipped: questions.length - pending.length,
    failures,
    metrics: complete ? await finishRun(run.id, deps) : null,
  };
}
