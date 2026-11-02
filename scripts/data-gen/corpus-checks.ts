import { parseDocx } from '@/server/ingest/parsers/docx';

import type { Fact } from '../../data-gen/schemas/registry';
import { describeError } from './describe-error';
import { mentionsFact, normalizeText } from './document-checks';
import { findBlocklistHits, findForbiddenPatterns, findFormatErrors } from './text-checks';

export type CorpusDocumentInput = {
  slug: string;
  docx: Buffer;
  facts: Fact[];
  blocklist: string[];
};

export type CorpusDocumentReport = {
  slug: string;
  passed: boolean;
  factCount: number;
  missingFacts: string[];
  errors: string[];
};

export type CorpusReport = {
  passed: boolean;
  documentCount: number;
  factCount: number;
  missingFactCount: number;
  documents: CorpusDocumentReport[];
};

function checkText(text: string, blocklist: string[]): string[] {
  return [
    ...findFormatErrors(text),
    ...findBlocklistHits(text, blocklist).map((name) => `blocklisted name: ${name}`),
    ...findForbiddenPatterns(text).map((label) => `forbidden pattern: ${label}`),
  ];
}

export async function checkCorpusDocument(input: CorpusDocumentInput): Promise<CorpusDocumentReport> {
  const { slug, docx, facts, blocklist } = input;
  let text = '';
  const errors: string[] = [];
  try {
    ({ text } = await parseDocx(docx));
    errors.push(...checkText(text, blocklist));
  } catch (err) {
    errors.push(`cannot parse: ${describeError(err)}`);
  }

  const normalized = normalizeText(text);
  const missingFacts = facts.filter((fact) => !mentionsFact(normalized, fact)).map((fact) => fact.factId);
  return {
    slug,
    passed: errors.length === 0 && missingFacts.length === 0,
    factCount: facts.length,
    missingFacts,
    errors,
  };
}

export function summarizeReports(documents: CorpusDocumentReport[]): CorpusReport {
  return {
    passed: documents.every((document) => document.passed),
    documentCount: documents.length,
    factCount: documents.reduce((sum, document) => sum + document.factCount, 0),
    missingFactCount: documents.reduce((sum, document) => sum + document.missingFacts.length, 0),
    documents,
  };
}
