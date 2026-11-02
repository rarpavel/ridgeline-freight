import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { evalQuestionSchema, generatedQuestionsSchema } from '../../data-gen/schemas/questions';
import { rateSheetSchema } from '../../data-gen/schemas/rate-sheet';
import { FACT_CATEGORIES, factSchema, registrySchema } from '../../data-gen/schemas/registry';

const FACT = {
  factId: 'msa-harbor-point-foods#03',
  docSlug: 'msa-harbor-point-foods',
  category: 'penalty',
  statement: 'Late deliveries earn the customer a credit per shipment.',
  value: '$250.00',
  aliases: ['$250.00', '$250'],
  valueType: 'money',
};

const QUESTION = {
  slug: 'comparison-03',
  category: 'comparison',
  role: 'sales',
  question: 'Which customer gets the bigger credit when a load shows up a day late?',
  expectedAnswer: 'Harbor Point Foods receives $250.00 per late shipment.',
  expectedDocSlugs: ['msa-harbor-point-foods'],
  sourceFactIds: ['msa-harbor-point-foods#03'],
  distractorDocSlugs: [],
  notes: 'Needs per-document attribution.',
};

const RATE_SHEET = {
  title: 'Accessorial Fee Schedule (2026)',
  effectiveDate: '01/01/2026',
  intro: 'These charges apply to services beyond standard transportation.',
  tables: [
    {
      title: 'Accessorial Charges',
      columns: ['Service', 'Charge'],
      rows: [['Detention', '$65.00']],
    },
  ],
  notes: [],
};

describe('registrySchema', () => {
  it('accepts a valid registry', () => {
    expect(registrySchema.safeParse({ version: '2026.11-1', facts: [FACT] }).success).toBe(true);
  });

  it('rejects a malformed factId and unknown fields', () => {
    expect(factSchema.safeParse({ ...FACT, factId: 'msa#3' }).success).toBe(false);
    expect(factSchema.safeParse({ ...FACT, extra: true }).success).toBe(false);
  });

  it('stays in sync with registry.schema.json', () => {
    const jsonSchema = JSON.parse(readFileSync('data-gen/schemas/registry.schema.json', 'utf8'));
    const items = jsonSchema.properties.facts.items;

    expect(items.properties.category.enum).toEqual([...FACT_CATEGORIES]);
    expect(Object.keys(items.properties).sort()).toEqual(Object.keys(factSchema.shape).sort());
    for (const field of items.required) {
      expect(
        factSchema.shape[field as keyof typeof factSchema.shape].safeParse(undefined).success,
      ).toBe(false);
    }
  });
});

describe('rateSheetSchema', () => {
  it('accepts a valid sheet', () => {
    expect(rateSheetSchema.safeParse(RATE_SHEET).success).toBe(true);
  });

  it('rejects a row whose cell count differs from the columns', () => {
    const table = { ...RATE_SHEET.tables[0], rows: [['Detention']] };
    expect(rateSheetSchema.safeParse({ ...RATE_SHEET, tables: [table] }).success).toBe(false);
  });

  it('rejects a date outside MM/DD/YYYY', () => {
    expect(rateSheetSchema.safeParse({ ...RATE_SHEET, effectiveDate: '2026-01-01' }).success).toBe(
      false,
    );
  });
});

describe('question schemas', () => {
  it('accepts model output, including a null answer', () => {
    const refusal = {
      ...QUESTION,
      slug: 'no_answer-01',
      category: 'no_answer',
      expectedAnswer: null,
    };
    expect(generatedQuestionsSchema.safeParse([QUESTION, refusal]).success).toBe(true);
  });

  it('rejects a slug outside the category pattern', () => {
    expect(generatedQuestionsSchema.safeParse([{ ...QUESTION, slug: 'q-1' }]).success).toBe(false);
  });

  it('requires the fields the script adds after generation', () => {
    expect(evalQuestionSchema.safeParse(QUESTION).success).toBe(false);
    expect(
      evalQuestionSchema.safeParse({
        ...QUESTION,
        split: 'dev',
        reviewed: false,
        datasetVersion: '2026.11-1',
      }).success,
    ).toBe(true);
  });
});
