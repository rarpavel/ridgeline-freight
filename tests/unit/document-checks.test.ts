import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { catalogSchema } from '../../data-gen/schemas/catalog';
import { registrySchema, type Fact } from '../../data-gen/schemas/registry';
import { worldSchema } from '../../data-gen/schemas/world';
import { checkDocument, normalizeText } from '../../scripts/data-gen/document-checks';
import {
  buildWorldSlice,
  effectiveDateOf,
  generateChecked,
  parsePromptTemplate,
  parseTypeGuidance,
} from '../../scripts/data-gen/document-generation';
import { parseBlocklist } from '../../scripts/data-gen/text-checks';

const catalog = catalogSchema.parse(JSON.parse(readFileSync('data/catalog.json', 'utf8')));
const world = worldSchema.parse(JSON.parse(readFileSync('data/world.json', 'utf8')));
const registry = registrySchema.parse(JSON.parse(readFileSync('data/registry.json', 'utf8')));
const blocklist = parseBlocklist(readFileSync('data-gen/blocklist.txt', 'utf8'));
const promptFile = readFileSync('data-gen/prompts/02-document-from-facts.md', 'utf8');

const TITLE = 'Carrier Agreement — Test';
const WRITTEN_TYPES = ['msa', 'carrier_agreement', 'hr_policy', 'sop'];

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    factId: 'carrier-test#01',
    docSlug: 'carrier-test',
    category: 'fee',
    statement: 'Detention is billed at $50.00 per hour after free time.',
    value: '$50.00',
    aliases: ['$50'],
    valueType: 'money',
    isException: false,
    ...overrides,
  };
}

function makeDocument(body: string, sections = 8, words = 1300): string {
  const headings = Array.from({ length: sections }, (_, i) => `## ${i + 1}. Section`).join('\n');
  return `# ${TITLE}\n\n${headings}\n\n${body}\n\n${'word '.repeat(words)}`;
}

function check(markdown: string, facts: Fact[] = [makeFact()]) {
  return checkDocument(markdown, {
    title: TITLE,
    facts,
    blocklist: ['Landstar'],
    allowedText: JSON.stringify(facts),
  });
}

describe('normalizeText', () => {
  it('ignores case, whitespace, emphasis, curly quotes and dash variants', () => {
    expect(normalizeText('**Third‑Party**  Driver’s\n$50.00')).toBe("third-party driver's $50.00");
  });
});

describe('checkDocument', () => {
  it('passes a document that meets every rule', () => {
    const report = check(makeDocument('Detention is billed at $50.00 per hour.'));

    expect(report.errors).toEqual([]);
    expect(report.sectionCount).toBe(8);
  });

  it('rejects a wrong first line', () => {
    const report = check(makeDocument('$50.00').replace(TITLE, 'Other Title'));

    expect(report.errors).toContainEqual(expect.stringContaining('first line'));
  });

  it('rejects fewer than 8 sections', () => {
    expect(check(makeDocument('$50.00', 7)).errors).toEqual([
      '7 "##" sections, expected at least 8',
    ]);
  });

  it.each([
    [1100, 'too short'],
    [2500, 'too long'],
  ])('rejects a document of %i words as %s', (words) => {
    expect(check(makeDocument('$50.00', 8, words)).errors).toContainEqual(
      expect.stringContaining('words, expected 1200-2400'),
    );
  });

  it('rejects a missing fact and names it', () => {
    expect(check(makeDocument('No amounts here.')).errors).toContainEqual(
      expect.stringContaining('missing fact carrier-test#01'),
    );
  });

  it('accepts a fact stated through an alias', () => {
    expect(check(makeDocument('Detention is billed at $50 per hour.')).errors).toEqual([]);
  });

  it('accepts a sentence-long value without its final period', () => {
    const fact = makeFact({
      value: 'TONU fee applies unless notice is given.',
      aliases: ['tonu notice'],
    });

    expect(
      check(makeDocument('A TONU fee applies unless notice is given, in writing.'), [fact]).errors,
    ).toEqual([]);
  });

  it('rejects blocklisted names, URLs, emails and phone numbers', () => {
    const report = check(makeDocument('$50.00 Landstar https://x.test a@b.test 312-555-0142'));

    expect(report.errors).toEqual(
      expect.arrayContaining([
        'blocklisted name: Landstar',
        'forbidden pattern: url',
        'forbidden pattern: email',
        'forbidden pattern: phone',
      ]),
    );
  });

  it.each(['$75.00', '12/25/2026', '3.5%'])('rejects the invented token %s', (token) => {
    expect(check(makeDocument(`$50.00 and ${token} apply.`)).errors).toContainEqual(
      expect.stringContaining(`${token} is not in FACTS or WORLD`),
    );
  });

  it('only warns about a standalone number outside the allowed set', () => {
    const report = check(makeDocument('$50.00 applies within 45 days and 3 steps.'));

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual(['unexpected number 45']);
  });

  it('does not warn about money, dates or section numbers', () => {
    const fact = makeFact({
      statement: 'Amount $1,250.00 from 04/15/2026.',
      value: '$1,250.00',
      aliases: ['$1,250'],
    });
    const report = check(makeDocument('Pay $1,250.00 from 04/15/2026.\n\n### 14.2 Heading'), [
      fact,
    ]);

    expect(report.warnings).toEqual([]);
  });

  describe('exception facts', () => {
    const exception = makeFact({
      statement:
        'Cargo liability is limited to $50.00 per occurrence, except for hazmat shipments.',
      isException: true,
    });

    it('passes when the rule and the exception share a sentence', () => {
      const sentence =
        'Liability is limited to $50.00 per occurrence, except for hazmat shipments.';
      const report = check(makeDocument(sentence), [exception]);

      expect(report.errors).toEqual([]);
      expect(report.exceptionSentences).toEqual([{ factId: exception.factId, sentence }]);
    });

    it('fails when the exception is in a separate sentence', () => {
      const body = 'Liability is limited to $50.00 per occurrence. This excludes hazmat shipments.';

      expect(check(makeDocument(body), [exception]).errors).toContainEqual(
        expect.stringContaining('state the exception in the same sentence'),
      );
    });

    it('does not split a sentence at the decimal point of an amount', () => {
      const body = 'Liability of $50.00 applies unless the shipment is hazmat.';

      expect(check(makeDocument(body), [exception]).errors).toEqual([]);
    });

    it('needs no exception word when the statement has none', () => {
      const fact = makeFact({
        statement: 'Lodging above $50.00 requires pre-approval by the CFO.',
        isException: true,
      });

      expect(
        check(makeDocument('Lodging above $50.00 requires pre-approval.'), [fact]).errors,
      ).toEqual([]);
    });
  });
});

describe('generateChecked', () => {
  const failUntil = (good: string) => (markdown: string) => ({
    errors: markdown === good ? [] : ['too short'],
  });

  it('does not retry a document that passes', async () => {
    const complete = vi.fn().mockResolvedValue('good');

    const result = await generateChecked('prompt', complete, failUntil('good'));

    expect(result.attempts).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('retries with the error text in the prompt', async () => {
    const complete = vi.fn().mockResolvedValueOnce('bad').mockResolvedValueOnce('good');

    const result = await generateChecked('prompt', complete, failUntil('good'));

    expect(result).toMatchObject({ markdown: 'good', attempts: 2 });
    expect(complete.mock.calls[1]?.[0]).toContain('prompt');
    expect(complete.mock.calls[1]?.[0]).toContain('- too short');
  });

  it('stops after 2 retries and returns the last errors', async () => {
    const complete = vi.fn().mockResolvedValue('bad');

    const result = await generateChecked('prompt', complete, failUntil('good'));

    expect(complete).toHaveBeenCalledTimes(3);
    expect(result.report.errors).toEqual(['too short']);
  });
});

describe('prompt parts', () => {
  it('extracts the template and the guidance of every written type', () => {
    expect(parsePromptTemplate(promptFile)).toContain('{{facts_json}}');
    for (const type of WRITTEN_TYPES) {
      expect(parseTypeGuidance(promptFile, type).length).toBeGreaterThan(20);
    }
  });

  it('throws for a type without guidance', () => {
    expect(() => parseTypeGuidance(promptFile, 'rate_sheet')).toThrow('rate_sheet');
  });
});

describe('effectiveDateOf', () => {
  it('throws when a document has no date fact', () => {
    expect(() => effectiveDateOf('carrier-test', [makeFact()])).toThrow('found 0');
  });

  it('gives every written document exactly one date fact', () => {
    for (const { slug, type } of catalog) {
      if (!WRITTEN_TYPES.includes(type)) continue;
      const facts = registry.facts.filter((fact) => fact.docSlug === slug);
      expect(effectiveDateOf(slug, facts)).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    }
  });
});

describe('buildWorldSlice', () => {
  it('keeps the company, the own entity and the entities the facts reference', () => {
    const entry = catalog.find(({ slug }) => slug === 'msa-northline-auto')!;
    const lane = world.lanes[0]!;

    const slice = buildWorldSlice(entry, [makeFact({ entityIds: [lane.id] })], world);

    expect(slice).toMatchObject({
      company: world.company,
      customers: [{ id: 'cust-northline-auto' }],
      carriers: [],
      lanes: [{ id: lane.id }],
      warehouses: [],
    });
  });
});

describe('data/generated/md', () => {
  const written = catalog.filter(({ type }) => WRITTEN_TYPES.includes(type));

  it.each(written.map(({ slug, title }) => [slug, title] as const))(
    '%s passes every check',
    (slug, title) => {
      const file = `data/generated/md/${slug}.md`;
      expect(existsSync(file)).toBe(true);
      const facts = registry.facts.filter((fact) => fact.docSlug === slug);
      const entry = written.find((candidate) => candidate.slug === slug)!;

      const report = checkDocument(readFileSync(file, 'utf8').trim(), {
        title,
        facts,
        blocklist,
        allowedText: `${JSON.stringify(buildWorldSlice(entry, facts, world))}\n${JSON.stringify(facts)}`,
      });

      expect(report.errors).toEqual([]);
    },
  );
});
