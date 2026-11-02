import { describe, expect, it, vi } from 'vitest';

import type { Fact } from '../../data-gen/schemas/registry';
import { checkCorpusDocument, summarizeReports } from '../../scripts/data-gen/corpus-checks';
import { renderDocx } from '../../scripts/data-gen/markdown-docx';
import { findFormatErrors } from '../../scripts/data-gen/text-checks';

vi.mock('server-only', () => ({}));

const OPTIONS = { companyName: 'Ridgeline Freight, LLC', documentId: 'doc-1' };

function fact(factId: string, value: string, aliases: string[]): Fact {
  return {
    factId,
    docSlug: 'doc',
    category: 'other',
    statement: 'A statement long enough for the schema.',
    value,
    aliases,
    valueType: 'text',
    isException: false,
  };
}

async function check(markdown: string, facts: Fact[] = [], blocklist: string[] = []) {
  const docx = await renderDocx(markdown, OPTIONS);
  return checkCorpusDocument({ slug: 'doc', docx, facts, blocklist });
}

describe('checkCorpusDocument', () => {
  it('passes a clean document whose facts are all present', async () => {
    const report = await check('# T\n\nPayment is Net 30, dated 04/01/2026, up to $1,250.00.\n', [
      fact('doc#01', 'Net 30', ['thirty days']),
    ]);
    expect(report).toEqual({
      slug: 'doc',
      passed: true,
      factCount: 1,
      missingFacts: [],
      errors: [],
    });
  });

  it('fails a document with an ISO date and names the date format', async () => {
    const report = await check('# T\n\nThis Agreement is effective 2026-04-01.\n');
    expect(report.passed).toBe(false);
    expect(report.errors).toEqual(['ISO date 2026-04-01: dates must be MM/DD/YYYY']);
  });

  it('finds a fact through an alias, ignoring case, quotes, dashes and whitespace', async () => {
    const report = await check('# T\n\nThe “Late   Fee” applies—always.\n', [
      fact('doc#01', 'not in the text', ['the "late fee" applies-always']),
    ]);
    expect(report.missingFacts).toEqual([]);
  });

  it('finds a fact by its value without a final period', async () => {
    const report = await check('# T\n\nDisputes go to arbitration in Chicago, as agreed.\n', [
      fact('doc#01', 'Disputes go to arbitration in Chicago.', ['no such alias']),
    ]);
    expect(report.missingFacts).toEqual([]);
  });

  it('finds a fact that only exists in a table cell', async () => {
    const report = await check(
      '# T\n\n| Service | Charge |\n| --- | --- |\n| Liftgate | $75.00 |\n',
      [fact('doc#01', '$75.00', ['$75.00'])],
    );
    expect(report.passed).toBe(true);
  });

  it('lists a missing fact and fails', async () => {
    const report = await check('# T\n\nNothing relevant.\n', [
      fact('doc#01', 'Net 30', ['thirty days']),
    ]);
    expect(report.passed).toBe(false);
    expect(report.missingFacts).toEqual(['doc#01']);
  });

  it('does not match a fact across a difference in the words', async () => {
    const report = await check('# T\n\nPayment is Net 45.\n', [
      fact('doc#01', 'Net 30', ['net thirty']),
    ]);
    expect(report.missingFacts).toEqual(['doc#01']);
  });

  it('reports blocklisted names, URLs, emails and phones', async () => {
    const report = await check(
      '# T\n\nHauled by Landstar. See https://example.test, write to a@b.test, call 312-555-0142.\n',
      [],
      ['Landstar'],
    );
    expect(report.errors).toEqual([
      'blocklisted name: Landstar',
      'forbidden pattern: url',
      'forbidden pattern: email',
      'forbidden pattern: phone',
    ]);
  });

  it('fails a document that cannot be parsed instead of throwing', async () => {
    const report = await checkCorpusDocument({
      slug: 'doc',
      docx: Buffer.from('not a zip'),
      facts: [fact('doc#01', 'Net 30', ['thirty days'])],
      blocklist: [],
    });
    expect(report.passed).toBe(false);
    expect(report.errors[0]).toMatch(/^cannot parse:/);
    expect(report.missingFacts).toEqual(['doc#01']);
  });
});

describe('findFormatErrors', () => {
  it.each([
    ['Effective 2026-04-01.', 'ISO date 2026-04-01: dates must be MM/DD/YYYY'],
    ['Effective 4/1/2026.', 'date 4/1/2026: dates must be MM/DD/YYYY'],
    ['Effective 04/01/26.', 'date 04/01/26: dates must be MM/DD/YYYY'],
    ['Effective April 1, 2026.', 'date April 1, 2026: dates must be MM/DD/YYYY'],
    ['A fee of $1250.00 applies.', 'amount $1250.00: amounts must look like $1,250.00'],
    ['A rate of $2.5 applies.', 'amount $2.5: amounts must look like $1,250.00'],
    ['A rate of $2.855 applies.', 'amount $2.855: amounts must look like $1,250.00'],
    ['A fee of €50 applies.', 'non-US currency symbol €'],
    ['A fee of £50 applies.', 'non-US currency symbol £'],
  ])('flags %s', (text, message) => {
    expect(findFormatErrors(text)).toEqual([message]);
  });

  it.each([
    'Effective 04/01/2026, ending 12/31/2027.',
    'Fees of $5, $75.00, $1,250.00 and $1,000,000.',
    'Pays $350.00. Then $12.50, and lane L-01 on route 2026-12.',
    'The May 2026 schedule, 24/7 dispatch and a 53/48 trailer.',
  ])('accepts %s', (text) => {
    expect(findFormatErrors(text)).toEqual([]);
  });

  it('reports a repeated token once', () => {
    expect(findFormatErrors('2026-04-01 and 2026-04-01')).toHaveLength(1);
  });
});

describe('summarizeReports', () => {
  it('counts documents, facts and missing facts, and fails if any document fails', () => {
    const good = { slug: 'a', passed: true, factCount: 2, missingFacts: [], errors: [] };
    const bad = { slug: 'b', passed: false, factCount: 3, missingFacts: ['b#01'], errors: [] };
    expect(summarizeReports([good])).toMatchObject({
      passed: true,
      documentCount: 1,
      factCount: 2,
      missingFactCount: 0,
    });
    expect(summarizeReports([good, bad])).toMatchObject({
      passed: false,
      documentCount: 2,
      factCount: 5,
      missingFactCount: 1,
      documents: [good, bad],
    });
  });
});
