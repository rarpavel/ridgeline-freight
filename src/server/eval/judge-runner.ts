import 'server-only';

import { z } from 'zod';

import { loadPrompt } from '@/server/prompts/load';
import { renderPrompt } from '@/server/prompts/render';

import type { Category, JudgeScores } from './metrics';

const MAX_ATTEMPTS = 2;

const judgePrompt = loadPrompt('judge', 1);

// Mirrors the output schema in data-gen/prompts/06-judge.md.
const judgeReplySchema = z.strictObject({
  correctness: z.union([z.literal(0), z.literal(1)]),
  faithfulness: z.number().min(0).max(1),
  claims: z.array(
    z.object({
      claim: z.string(),
      supported: z.boolean(),
      citation: z.number().int().nullable(),
    }),
  ),
  refusalCorrect: z.boolean().nullable(),
  rationale: z.string().min(20),
});

type JudgeReply = z.infer<typeof judgeReplySchema>;

export type CompleteJudge = (prompt: string, signal: AbortSignal) => Promise<string>;

export type JudgeFact = { value: string; aliases: readonly string[] };

export type CitedPassage = { n: number; document: string; section: string; text: string };

export type JudgeInput = {
  category: Category;
  question: string;
  role: string;
  expectedAnswer: string | null;
  facts: readonly JudgeFact[];
  answer: string;
  refused: boolean;
  citedPassages: readonly CitedPassage[];
};

export type JudgeVerdict = { scores: JudgeScores; rationale: string | null };

function renderJudgePrompt(input: JudgeInput): string {
  return renderPrompt(judgePrompt.text, {
    category: input.category,
    role: input.role,
    question: input.question,
    expected_answer: input.expectedAnswer ?? 'null',
    facts_json: JSON.stringify(input.facts),
    refused: String(input.refused),
    answer: input.answer,
    cited_passages_json: JSON.stringify(input.citedPassages),
  });
}

function parseReply(reply: string): { data: JudgeReply } | { error: string } {
  const text = reply
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
  try {
    const parsed = judgeReplySchema.safeParse(JSON.parse(text));
    return parsed.success ? { data: parsed.data } : { error: z.prettifyError(parsed.error) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function toVerdict(reply: JudgeReply, { expectedAnswer, refused }: JudgeInput): JudgeVerdict {
  const { correctness, claims, refusalCorrect, rationale } = reply;
  const supported = claims.filter((claim) => claim.supported).length;
  // Rule C of the rubric, from what the system did: only the judge's own reading can disagree.
  const expectedRefusalCorrect = refused ? expectedAnswer === null : null;
  return {
    scores: {
      correctness,
      // The model's own number is ignored: the rubric defines it as this ratio.
      faithfulness: claims.length === 0 ? 1 : supported / claims.length,
      claims,
      judgeRefusalCorrect: refusalCorrect,
      // An answer with no claims would read as fully faithful with nothing checked.
      needsReview: refusalCorrect !== expectedRefusalCorrect || (!refused && claims.length === 0),
    },
    rationale,
  };
}

/**
 * Never throws: one result the judge could not score must not cost the run (EVALUATION.md §4). A
 * provider failure is not retried here, because the SDK has already retried it.
 */
export async function judgeResult(
  input: JudgeInput,
  { complete, signal }: { complete: CompleteJudge; signal: AbortSignal },
): Promise<JudgeVerdict> {
  const prompt = renderJudgePrompt(input);
  let nextPrompt = prompt;
  let judgeError = '';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let reply: string;
    try {
      reply = await complete(nextPrompt, signal);
    } catch (err) {
      judgeError = err instanceof Error ? err.message : String(err);
      break;
    }
    const parsed = parseReply(reply);
    if ('data' in parsed) return toVerdict(parsed.data, input);
    judgeError = parsed.error;
    nextPrompt = `${prompt}\n\nYour previous reply was rejected: ${judgeError}\nReturn the corrected JSON only.`;
  }
  return { scores: { judgeError }, rationale: null };
}
