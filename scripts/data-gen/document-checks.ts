import type { Fact } from '../../data-gen/schemas/registry';
import { findBlocklistHits, findForbiddenPatterns } from './text-checks';

const MIN_SECTIONS = 8;
const MIN_WORDS = 1200;
const MAX_WORDS = 2400;
// The middle of the range, so a retry that misses the requested length by a little still passes.
const TARGET_WORDS = 1800;
// Standalone numbers up to this one are ordinary prose and list numbering.
const MAX_UNCHECKED_NUMBER = 12;

const EXCEPTION_WORDS = /\b(except|unless|exclude|excludes|excluding|excluded|other than|only if)\b/;
const SENTENCE_END = /(?<=[.!?])\s+|\n+/;
const HEADING_LINE = /^#+ .*$/gm;
export const MONEY = /\$\d[\d,]*(?:\.\d+)?/g;
const DATE =/\b\d{2}\/\d{2}\/\d{4}\b/g;
const PERCENT = /\b\d+(?:\.\d+)?%/g;
const NUMBER = /(?<![\d$.,/])\b\d[\d,]*\b(?![\d.,/%]*\d)/g;

export type DocumentInput = {
  title: string;
  facts: Fact[];
  blocklist: string[];
  // World bible and fact text: the only place numbers may come from.
  allowedText: string;
};

export type DocumentReport = {
  errors: string[];
  // Standalone numbers outside the allowed set: reviewed by hand, they do not fail a document.
  warnings: string[];
  exceptionSentences: { factId: string; sentence: string }[];
  wordCount: number;
  sectionCount: number;
};

// Same rules as datagen:validate: whitespace, quotes, dashes and case do not count as differences.
export function normalizeText(text: string): string {
  return text
    .replace(/\*/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function factForms(fact: Fact): string[] {
  return [fact.value, ...fact.aliases].map((form) => normalizeText(form).replace(/\.$/, ''));
}

export function mentionsFact(normalized: string, fact: Fact): boolean {
  return factForms(fact).some((form) => normalized.includes(form));
}

function findUnknownTokens(markdown: string, allowedText: string): string[] {
  const patterns = [MONEY, DATE, PERCENT];
  const allowed = new Set(patterns.flatMap((pattern) => allowedText.match(pattern) ?? []));
  const found = patterns.flatMap((pattern) => markdown.match(pattern) ?? []);
  return [...new Set(found.filter((token) => !allowed.has(token)))];
}

function findUnknownNumbers(markdown: string, allowedText: string): string[] {
  const allowed = new Set(allowedText.match(/\d[\d,]*/g) ?? []);
  const body = markdown.replace(HEADING_LINE, '');
  const found = body.match(NUMBER) ?? [];
  return [
    ...new Set(
      found.filter(
        (token) => !allowed.has(token) && Number(token.replace(/,/g, '')) > MAX_UNCHECKED_NUMBER,
      ),
    ),
  ];
}

function exceptionSentence(markdown: string, fact: Fact): string | undefined {
  const sentences = markdown.split(SENTENCE_END).filter((sentence) => mentionsFact(normalizeText(sentence), fact));
  const needsWord = EXCEPTION_WORDS.test(normalizeText(fact.statement));
  if (!needsWord) return sentences[0];
  return sentences.find((sentence) => EXCEPTION_WORDS.test(normalizeText(sentence)));
}

function checkStructure(markdown: string, title: string): string[] {
  const errors: string[] = [];
  const firstLine = markdown.split('\n', 1)[0];
  if (firstLine !== `# ${title}`) errors.push(`first line must be exactly "# ${title}"`);
  return errors;
}

export function checkDocument(markdown: string, input: DocumentInput): DocumentReport {
  const { title, facts, blocklist, allowedText } = input;
  const wordCount = markdown.split(/\s+/).filter((word) => /[a-z0-9]/i.test(word)).length;
  const sectionCount = markdown.match(/^## /gm)?.length ?? 0;

  const errors = checkStructure(markdown, title);
  if (sectionCount < MIN_SECTIONS) {
    errors.push(`${sectionCount} "##" sections, expected at least ${MIN_SECTIONS}`);
  }
  if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
    const change =
      wordCount < MIN_WORDS
        ? `add at least ${TARGET_WORDS - wordCount} more words`
        : `remove at least ${wordCount - TARGET_WORDS} words`;
    errors.push(
      `${wordCount} words, expected ${MIN_WORDS}-${MAX_WORDS}: ${change} of boilerplate, keeping every fact`,
    );
  }
  const factCheck = checkFactMentions(markdown, facts, blocklist);
  errors.push(...factCheck.errors);
  for (const token of findUnknownTokens(markdown, allowedText)) {
    errors.push(`${token} is not in FACTS or WORLD: remove it or use qualitative wording`);
  }

  return {
    errors,
    warnings: findUnknownNumbers(markdown, allowedText).map((token) => `unexpected number ${token}`),
    exceptionSentences: factCheck.exceptionSentences,
    wordCount,
    sectionCount,
  };
}

// Shared with rate sheets: every fact present, exceptions stated next to their value, no forbidden text.
export function checkFactMentions(
  markdown: string,
  facts: Fact[],
  blocklist: string[],
): Pick<DocumentReport, 'errors' | 'exceptionSentences'> {
  const normalized = normalizeText(markdown);
  const errors: string[] = [];
  for (const fact of facts) {
    if (!mentionsFact(normalized, fact)) {
      errors.push(`missing fact ${fact.factId}: state "${fact.statement}" with the value "${fact.value}"`);
    }
  }
  for (const name of findBlocklistHits(markdown, blocklist)) errors.push(`blocklisted name: ${name}`);
  for (const label of findForbiddenPatterns(markdown)) errors.push(`forbidden pattern: ${label}`);

  const exceptionSentences: DocumentReport['exceptionSentences'] = [];
  for (const fact of facts.filter((candidate) => candidate.isException)) {
    const sentence = exceptionSentence(markdown, fact);
    if (sentence) exceptionSentences.push({ factId: fact.factId, sentence });
    else if (mentionsFact(normalized, fact)) {
      errors.push(`${fact.factId}: state the exception in the same sentence as "${fact.value}": "${fact.statement}"`);
    }
  }
  return { errors, exceptionSentences };
}
