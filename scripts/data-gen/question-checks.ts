import { createHash } from 'node:crypto';

import type { CatalogEntry } from '../../data-gen/schemas/catalog';
import {
  generatedQuestionsSchema,
  type EvalQuestion,
  type GeneratedQuestion,
} from '../../data-gen/schemas/questions';
import type { Fact } from '../../data-gen/schemas/registry';
import { findBlocklistHits, findForbiddenPatterns, findFormatErrors, stripCodeFence } from './text-checks';

type Category = GeneratedQuestion['category'];

export const CATEGORY_COUNTS: Record<Category, number> = {
  direct: 16,
  comparison: 6,
  exception: 5,
  no_answer: 8,
  other_role: 5,
  broad: 4,
};

// 30% of each category by largest remainder, which adds up to dev 12 / test 28. `broad` guards the
// output limit while tuning, so it stays out of the published test split.
const DEV_COUNTS: Record<Category, number> = {
  direct: 5,
  comparison: 2,
  exception: 2,
  no_answer: 2,
  other_role: 1,
  broad: 4,
};

const BROAD_MIN_FACTS = 4;
const NGRAM_SIZE = 5;
const MIN_WORDS = 6;
const MAX_WORDS = 25;
// Text values are often whole sentences that an answer rewords, so manual review covers those.
const VERBATIM_VALUE_TYPES: Fact['valueType'][] = ['money', 'days', 'percent', 'date', 'number'];
// An amount or date stays one word; a hyphen splits, so "at-will" and "at will" compare equal.
const WORD = /[\p{L}\p{N}]+(?:[.,'’/][\p{L}\p{N}]+)*/gu;

export type QuestionDeps = { catalog: CatalogEntry[]; facts: Fact[]; blocklist: string[] };

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

// Returns the first run of `size` consecutive words of `text` that also occurs in `source`.
export function findSharedNgram(text: string, source: string, size = NGRAM_SIZE): string | undefined {
  const words = wordsOf(text);
  const sourceWords = wordsOf(source);
  const sourceNgrams = new Set(
    sourceWords.slice(0, sourceWords.length - size + 1).map((_, index) => {
      return sourceWords.slice(index, index + size).join(' ');
    }),
  );
  return words
    .slice(0, Math.max(words.length - size + 1, 0))
    .map((_, index) => words.slice(index, index + size).join(' '))
    .find((ngram) => sourceNgrams.has(ngram));
}

function containsValue(text: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d,.$])${escaped}(?!\\d|[,.]\\d)`, 'i').test(text);
}

function checkSlugs(question: GeneratedQuestion, catalog: CatalogEntry[]): string[] {
  const known = new Set(catalog.map(({ slug }) => slug));
  const unknown = [...question.expectedDocSlugs, ...question.distractorDocSlugs]
    .filter((slug) => !known.has(slug))
    .map((slug) => `${slug} is not in the catalog`);
  const both = question.distractorDocSlugs
    .filter((slug) => question.expectedDocSlugs.includes(slug))
    .map((slug) => `${slug} is both expected and a distractor`);
  return [...unknown, ...both];
}

function checkSourceFacts(question: GeneratedQuestion, facts: Fact[]): string[] {
  const errors: string[] = [];
  for (const factId of question.sourceFactIds) {
    const fact = facts.find((candidate) => candidate.factId === factId);
    if (!fact) errors.push(`${factId} is not in the registry`);
    else if (!question.expectedDocSlugs.includes(fact.docSlug)) {
      errors.push(`${factId} is not from an expected document`);
    }
  }
  for (const slug of question.expectedDocSlugs) {
    if (!question.sourceFactIds.some((factId) => factId.startsWith(`${slug}#`))) {
      errors.push(`${slug} has no source fact`);
    }
  }
  return errors;
}

function checkRole(question: GeneratedQuestion, catalog: CatalogEntry[]): string[] {
  const errors: string[] = [];
  for (const slug of question.expectedDocSlugs) {
    const entry = catalog.find((candidate) => candidate.slug === slug);
    if (!entry) continue;
    const canRead = entry.roles.includes(question.role);
    if (question.category === 'other_role' && canRead) errors.push(`${question.role} can read ${slug}`);
    if (question.category !== 'other_role' && !canRead) {
      errors.push(`${question.role} cannot read ${slug}`);
    }
  }
  return errors;
}

function checkExpectedAnswer(question: GeneratedQuestion, sources: Fact[]): string[] {
  if (question.category === 'no_answer' || question.category === 'other_role') {
    return question.expectedAnswer === null ? [] : ['expectedAnswer must be null'];
  }
  if (question.expectedAnswer === null) return ['expectedAnswer is required'];
  const answer = question.expectedAnswer;
  return sources
    .filter((fact) => VERBATIM_VALUE_TYPES.includes(fact.valueType))
    .filter((fact) => ![fact.value, ...fact.aliases].some((value) => containsValue(answer, value)))
    .map((fact) => `expectedAnswer lacks ${fact.value} from ${fact.factId}`);
}

function checkComparison(question: GeneratedQuestion, sources: Fact[], catalog: CatalogEntry[]): string[] {
  const errors: string[] = [];
  const [first, second] = sources;
  if (question.expectedDocSlugs.length !== 2 || question.sourceFactIds.length !== 2) {
    errors.push('comparison needs exactly two documents and two facts');
  }
  const types = question.expectedDocSlugs.map(
    (slug) => catalog.find((entry) => entry.slug === slug)?.type,
  );
  if (new Set(types).size > 1) errors.push('comparison documents must have the same type');
  if (first && second) {
    const linked =
      first.differsFrom?.includes(second.factId) || second.differsFrom?.includes(first.factId);
    if (!linked) errors.push('comparison facts are not linked by differsFrom');
  }
  if (question.distractorDocSlugs.length === 0) errors.push('comparison needs a distractor');
  return errors;
}

function checkCategoryShape(question: GeneratedQuestion, sources: Fact[], catalog: CatalogEntry[]): string[] {
  switch (question.category) {
    case 'direct':
      return question.expectedDocSlugs.length === 1 && question.sourceFactIds.length === 1
        ? []
        : ['direct needs exactly one document and one fact'];
    case 'comparison':
      return checkComparison(question, sources, catalog);
    case 'exception':
      return sources.some((fact) => fact.isException) ? [] : ['exception needs a fact with isException'];
    case 'no_answer':
      return question.expectedDocSlugs.length === 0 && question.sourceFactIds.length === 0
        ? []
        : ['no_answer must have no documents or facts'];
    case 'other_role':
      return question.expectedDocSlugs.length > 0 ? [] : ['other_role needs at least one expected document'];
    case 'broad':
      return question.sourceFactIds.length >= BROAD_MIN_FACTS
        ? []
        : [`broad needs at least ${BROAD_MIN_FACTS} facts`];
  }
}

function checkOverlap(question: GeneratedQuestion, sources: Fact[]): string[] {
  return sources.flatMap((fact) => {
    const shared = findSharedNgram(question.question, fact.statement);
    return shared ? [`question shares "${shared}" with ${fact.factId}`] : [];
  });
}

function checkText(question: GeneratedQuestion, blocklist: string[]): string[] {
  const wordCount = wordsOf(question.question).length;
  const shown = [question.question, question.expectedAnswer ?? ''].join('\n');
  const all = `${shown}\n${question.notes}`;
  return [
    ...(wordCount < MIN_WORDS || wordCount > MAX_WORDS
      ? [`question has ${wordCount} words, expected ${MIN_WORDS}-${MAX_WORDS}`]
      : []),
    ...findFormatErrors(shown),
    ...findBlocklistHits(all, blocklist).map((name) => `blocklist hit ${name}`),
    ...findForbiddenPatterns(all).map((label) => `forbidden pattern ${label}`),
  ];
}

export function checkQuestion(question: GeneratedQuestion, deps: QuestionDeps): string[] {
  const { catalog, facts, blocklist } = deps;
  const sources = question.sourceFactIds.flatMap((factId) => {
    return facts.filter((fact) => fact.factId === factId);
  });
  const errors = [
    ...checkSlugs(question, catalog),
    ...checkSourceFacts(question, facts),
    ...checkRole(question, catalog),
    ...checkExpectedAnswer(question, sources),
    ...checkCategoryShape(question, sources, catalog),
    ...checkOverlap(question, sources),
    ...checkText(question, blocklist),
  ];
  return errors.map((error) => `${question.slug}: ${error}`);
}

export function parseBatch(reply: string): { questions: GeneratedQuestion[]; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(reply));
  } catch {
    return { questions: [], errors: ['reply is not valid JSON'] };
  }
  const parsed = generatedQuestionsSchema.safeParse(json);
  if (parsed.success) return { questions: parsed.data, errors: [] };
  const errors = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  return { questions: [], errors };
}

export function checkBatch(
  questions: GeneratedQuestion[],
  category: Category,
  deps: QuestionDeps,
): string[] {
  const errors: string[] = [];
  const expected = CATEGORY_COUNTS[category];
  if (questions.length !== expected) {
    errors.push(`${questions.length} ${category} questions, expected ${expected}`);
  }
  const seen = new Set<string>();
  for (const question of questions) {
    if (question.category !== category) {
      errors.push(`${question.slug}: category is ${question.category}, expected ${category}`);
    }
    if (!question.slug.startsWith(`${category}-`)) {
      errors.push(`${question.slug}: slug must start with ${category}-`);
    }
    if (seen.has(question.slug)) errors.push(`${question.slug}: duplicate slug`);
    seen.add(question.slug);
    errors.push(...checkQuestion(question, deps));
  }
  return errors;
}

// Ordered by a hash of the slug: not by position, which may follow the order the model thought of them,
// and with the same result on every run.
function devSlugs(questions: GeneratedQuestion[], category: Category): Set<string> {
  const ranked = questions
    .filter((question) => question.category === category)
    .map(({ slug }) => ({ slug, rank: createHash('sha256').update(slug).digest('hex') }))
    .sort((a, b) => a.rank.localeCompare(b.rank));
  return new Set(ranked.slice(0, DEV_COUNTS[category]).map(({ slug }) => slug));
}

export function assignSplits<T extends GeneratedQuestion>(questions: T[]): (T & { split: 'dev' | 'test' })[] {
  const categories = Object.keys(DEV_COUNTS) as Category[];
  const dev = new Set(categories.flatMap((category) => [...devSlugs(questions, category)]));
  return questions.map((question) => ({
    ...question,
    split: dev.has(question.slug) ? ('dev' as const) : ('test' as const),
  }));
}

function normalizeQuestion(text: string): string {
  return wordsOf(text).join(' ');
}

export function checkQuestionSet(questions: EvalQuestion[], deps: QuestionDeps): string[] {
  const categories = Object.keys(CATEGORY_COUNTS) as Category[];
  const errors = categories.flatMap((category) => {
    const batch = questions.filter((question) => question.category === category);
    const dev = batch.filter(({ split }) => split === 'dev').length;
    const splitError =
      dev === DEV_COUNTS[category]
        ? []
        : [`${category}: ${dev} dev questions, expected ${DEV_COUNTS[category]}`];
    return [...checkBatch(batch, category, deps), ...splitError];
  });

  const slugByText = new Map<string, string>();
  for (const { slug, question } of questions) {
    const text = normalizeQuestion(question);
    const first = slugByText.get(text);
    if (first) errors.push(`${slug} repeats the question of ${first}`);
    else slugByText.set(text, slug);
  }
  return errors;
}
