import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { catalogSchema } from '../../data-gen/schemas/catalog';
import {
  evalQuestionsSchema,
  type EvalQuestion,
  type GeneratedQuestion,
} from '../../data-gen/schemas/questions';
import { registrySchema, type Fact } from '../../data-gen/schemas/registry';
import {
  assignSplits,
  CATEGORY_COUNTS,
  checkBatch,
  checkQuestion,
  checkQuestionSet,
  findSharedNgram,
  parseBatch,
} from '../../scripts/data-gen/question-checks';
import { parseBlocklist } from '../../scripts/data-gen/text-checks';

const catalog = catalogSchema.parse(JSON.parse(readFileSync('data/catalog.json', 'utf8')));

function makeFact(overrides: Partial<Fact> & Pick<Fact, 'factId' | 'docSlug'>): Fact {
  return {
    category: 'penalty',
    statement: 'The carrier owes the customer a credit of $250.00 for each late shipment it delivers.',
    value: '$250.00',
    aliases: ['$250'],
    valueType: 'money',
    isException: false,
    ...overrides,
  };
}

const harborPenalty = makeFact({
  factId: 'msa-harbor-point-foods#03',
  docSlug: 'msa-harbor-point-foods',
  differsFrom: ['msa-lakeshore-retail#03'],
});
const lakeshorePenalty = makeFact({
  factId: 'msa-lakeshore-retail#03',
  docSlug: 'msa-lakeshore-retail',
  statement: 'A late shipment under this contract earns the customer a credit of $175.00 every time.',
  value: '$175.00',
  aliases: ['$175'],
});
const lakeshoreException = makeFact({
  factId: 'msa-lakeshore-retail#07',
  docSlug: 'msa-lakeshore-retail',
  category: 'exception',
  statement: 'A cancellation fee applies unless the customer gives written notice one day ahead of pickup.',
  value: 'Cancellation fee applies unless one day of written notice is given.',
  aliases: ['fee unless one day of notice'],
  valueType: 'text',
  isException: true,
});
const ptoAccrual = makeFact({
  factId: 'hr-pto-holidays#02',
  docSlug: 'hr-pto-holidays',
  category: 'policy_rule',
  statement: 'Full-time employees accrue fifteen days of paid time off in each calendar year.',
  value: '15 days',
  aliases: ['fifteen days'],
  valueType: 'days',
});

const deps = {
  catalog,
  facts: [harborPenalty, lakeshorePenalty, lakeshoreException, ptoAccrual],
  blocklist: ['Acme Freight'],
};

const direct: GeneratedQuestion = {
  slug: 'direct-01',
  category: 'direct',
  role: 'sales',
  question: 'A Harbor Point dispatcher wants to know what we pay when a truck shows up late.',
  expectedAnswer: 'Harbor Point Foods receives $250.00 per late shipment.',
  expectedDocSlugs: ['msa-harbor-point-foods'],
  sourceFactIds: ['msa-harbor-point-foods#03'],
  distractorDocSlugs: ['msa-lakeshore-retail'],
  notes: 'Another MSA has a similar clause.',
};

const comparison: GeneratedQuestion = {
  slug: 'comparison-01',
  category: 'comparison',
  role: 'sales',
  question: 'Who gets the bigger credit for a late load, Harbor Point Foods or Lakeshore Retail?',
  expectedAnswer: 'Harbor Point Foods receives $250.00; Lakeshore Retail Group receives $175.00.',
  expectedDocSlugs: ['msa-harbor-point-foods', 'msa-lakeshore-retail'],
  sourceFactIds: ['msa-harbor-point-foods#03', 'msa-lakeshore-retail#03'],
  distractorDocSlugs: ['msa-prairie-wind-mfg'],
  notes: 'Needs chunks from two MSAs.',
};

const exception: GeneratedQuestion = {
  slug: 'exception-01',
  category: 'exception',
  role: 'sales',
  question: 'Does Lakeshore Retail still pay if they cancel the truck the morning before pickup?',
  expectedAnswer: 'The fee applies unless Lakeshore Retail gave written notice one day ahead.',
  expectedDocSlugs: ['msa-lakeshore-retail'],
  sourceFactIds: ['msa-lakeshore-retail#07'],
  distractorDocSlugs: [],
  notes: 'Probes the notice qualifier.',
};

const noAnswer: GeneratedQuestion = {
  slug: 'no_answer-01',
  category: 'no_answer',
  role: 'hr',
  question: 'How much does the Chief Executive Officer earn in salary and bonus each year?',
  expectedAnswer: null,
  expectedDocSlugs: [],
  sourceFactIds: [],
  distractorDocSlugs: [],
  notes: 'Compensation is in no document.',
};

const otherRole: GeneratedQuestion = {
  slug: 'other_role-01',
  category: 'other_role',
  role: 'sales',
  question: 'How many vacation days does a full-time person on my team build up annually?',
  expectedAnswer: null,
  expectedDocSlugs: ['hr-pto-holidays'],
  sourceFactIds: ['hr-pto-holidays#02'],
  distractorDocSlugs: [],
  notes: 'Sales cannot read an hr_policy document.',
};

describe('findSharedNgram', () => {
  it('finds five consecutive shared words, ignoring case and punctuation', () => {
    expect(findSharedNgram('What credit of $250.00, for each late one?', 'A CREDIT OF $250.00 for each late shipment')).toBe(
      'credit of 250.00 for each',
    );
  });

  it('allows four consecutive shared words', () => {
    expect(findSharedNgram('a credit of $250.00 applies', 'a credit of $250.00 for each')).toBeUndefined();
  });

  it('counts an amount as one word', () => {
    expect(findSharedNgram('paid at $12,500.00 per load', 'owed at $12,500.00 per load')).toBeUndefined();
  });

  it('splits hyphenated words, so a hyphen does not hide an overlap', () => {
    expect(findSharedNgram('an at will employment deal here', 'an at-will employment deal here')).toBe(
      'an at will employment deal',
    );
  });
});

describe('checkQuestion', () => {
  it.each([direct, comparison, exception, noAnswer, otherRole])('passes $slug', (question) => {
    expect(checkQuestion(question, deps)).toEqual([]);
  });

  it('rejects a question that shares a 5-gram with the statement of its fact', () => {
    const errors = checkQuestion(
      { ...direct, question: 'Do they owe the customer a credit of $250.00 for a late shipment?' },
      deps,
    );
    expect(errors.join()).toContain('shares "the customer a credit of" with msa-harbor-point-foods#03');
  });

  it('rejects a fact id that is not in the registry', () => {
    const errors = checkQuestion({ ...direct, sourceFactIds: ['msa-harbor-point-foods#99'] }, deps);
    expect(errors.join()).toContain('msa-harbor-point-foods#99 is not in the registry');
  });

  it('rejects a fact that belongs to another document', () => {
    const errors = checkQuestion({ ...direct, sourceFactIds: ['msa-lakeshore-retail#03'] }, deps);
    expect(errors.join()).toContain('msa-lakeshore-retail#03 is not from an expected document');
  });

  it('rejects a slug that is not in the catalog', () => {
    const errors = checkQuestion({ ...direct, distractorDocSlugs: ['msa-unknown'] }, deps);
    expect(errors.join()).toContain('msa-unknown is not in the catalog');
  });

  it('rejects a distractor that is also expected', () => {
    const errors = checkQuestion({ ...direct, distractorDocSlugs: ['msa-harbor-point-foods'] }, deps);
    expect(errors.join()).toContain('msa-harbor-point-foods is both expected and a distractor');
  });

  it('rejects a role that cannot read an expected document', () => {
    const errors = checkQuestion({ ...direct, role: 'hr' }, deps);
    expect(errors.join()).toContain('hr cannot read msa-harbor-point-foods');
  });

  it.each(['sales', 'ops'] as const)('accepts %s asking about an hr document as other_role', (role) => {
    expect(checkQuestion({ ...otherRole, role }, deps)).toEqual([]);
  });

  it.each(['hr', 'admin'] as const)('rejects %s as other_role for an hr document', (role) => {
    const errors = checkQuestion({ ...otherRole, role }, deps);
    expect(errors.join()).toContain(`${role} can read hr-pto-holidays`);
  });

  it('rejects an other_role question with an expected answer', () => {
    const errors = checkQuestion({ ...otherRole, expectedAnswer: '15 days' }, deps);
    expect(errors.join()).toContain('expectedAnswer must be null');
  });

  it('rejects an other_role question without a document', () => {
    const errors = checkQuestion({ ...otherRole, expectedDocSlugs: [], sourceFactIds: [] }, deps);
    expect(errors.join()).toContain('needs at least one expected document');
  });

  it('rejects a no_answer question that points at a document', () => {
    const errors = checkQuestion(
      { ...noAnswer, expectedDocSlugs: ['hr-pto-holidays'], sourceFactIds: ['hr-pto-holidays#02'] },
      deps,
    );
    expect(errors.join()).toContain('no_answer must have no documents or facts');
  });

  it('rejects a direct question with two documents', () => {
    const errors = checkQuestion(
      {
        ...direct,
        expectedDocSlugs: ['msa-harbor-point-foods', 'msa-lakeshore-retail'],
        sourceFactIds: ['msa-harbor-point-foods#03', 'msa-lakeshore-retail#03'],
        expectedAnswer: '$250.00 and $175.00',
        distractorDocSlugs: [],
      },
      deps,
    );
    expect(errors.join()).toContain('direct needs exactly one document and one fact');
  });

  it('rejects an expected document with no source fact', () => {
    const errors = checkQuestion(
      { ...exception, expectedDocSlugs: ['msa-lakeshore-retail', 'msa-northline-auto'] },
      deps,
    );
    expect(errors.join()).toContain('msa-northline-auto has no source fact');
  });

  it('rejects an answerable question with no expected answer', () => {
    const errors = checkQuestion({ ...direct, expectedAnswer: null }, deps);
    expect(errors.join()).toContain('expectedAnswer is required');
  });

  it('rejects an expected answer without the value of its fact', () => {
    const errors = checkQuestion({ ...direct, expectedAnswer: 'Harbor Point Foods gets $300.00.' }, deps);
    expect(errors.join()).toContain('expectedAnswer lacks $250.00');
  });

  it('accepts an alias of the fact value in the expected answer', () => {
    const errors = checkQuestion({ ...direct, expectedAnswer: 'Harbor Point Foods gets $250 back.' }, deps);
    expect(errors).toEqual([]);
  });

  it('does not take a longer amount for the fact value', () => {
    const errors = checkQuestion({ ...direct, expectedAnswer: 'Harbor Point Foods gets $2,250.00.' }, deps);
    expect(errors.join()).toContain('expectedAnswer lacks $250.00');
  });

  it('rejects a comparison across documents of different types', () => {
    const errors = checkQuestion(
      {
        ...comparison,
        role: 'admin',
        expectedDocSlugs: ['msa-harbor-point-foods', 'hr-pto-holidays'],
        sourceFactIds: ['msa-harbor-point-foods#03', 'hr-pto-holidays#02'],
        expectedAnswer: '$250.00 and 15 days',
      },
      deps,
    );
    expect(errors.join()).toContain('comparison documents must have the same type');
  });

  it('rejects a comparison of facts with no differsFrom link', () => {
    const unlinked = { ...deps, facts: [{ ...harborPenalty, differsFrom: [] }, lakeshorePenalty] };
    expect(checkQuestion(comparison, unlinked).join()).toContain('facts are not linked by differsFrom');
  });

  it('accepts a differsFrom link in either direction', () => {
    const reversed = {
      ...deps,
      facts: [
        { ...harborPenalty, differsFrom: [] },
        { ...lakeshorePenalty, differsFrom: ['msa-harbor-point-foods#03'] },
      ],
    };
    expect(checkQuestion(comparison, reversed)).toEqual([]);
  });

  it('rejects a comparison without a distractor', () => {
    const errors = checkQuestion({ ...comparison, distractorDocSlugs: [] }, deps);
    expect(errors.join()).toContain('comparison needs a distractor');
  });

  it('rejects an exception question whose fact is not an exception', () => {
    const errors = checkQuestion(
      {
        ...exception,
        sourceFactIds: ['msa-lakeshore-retail#03'],
        expectedAnswer: 'Lakeshore Retail receives $175.00.',
      },
      deps,
    );
    expect(errors.join()).toContain('exception needs a fact with isException');
  });

  it.each([
    ['short', 'What is the late fee?'],
    [
      'long',
      'If a customer of ours in the Midwest were to call up one of our dispatchers late on a Friday evening to ask about what happens with a late truck, what do we say?',
    ],
  ])('rejects a question that is too %s', (_label, question) => {
    expect(checkQuestion({ ...noAnswer, question }, deps).join()).toContain('words, expected 6-25');
  });

  it('rejects an ISO date in the expected answer', () => {
    const errors = checkQuestion(
      { ...direct, expectedAnswer: 'Harbor Point Foods gets $250.00 since 2026-04-01.' },
      deps,
    );
    expect(errors.join()).toContain('ISO date 2026-04-01');
  });

  it('rejects a blocklisted name and a forbidden pattern', () => {
    const errors = checkQuestion(
      { ...noAnswer, question: 'Do we ship for Acme Freight, and is their site at http://acme.test?' },
      deps,
    );
    expect(errors.join()).toContain('blocklist hit Acme Freight');
    expect(errors.join()).toContain('forbidden pattern url');
  });
});

describe('parseBatch', () => {
  it('parses a fenced JSON array', () => {
    const { questions, errors } = parseBatch(`\`\`\`json\n${JSON.stringify([direct])}\n\`\`\``);
    expect(errors).toEqual([]);
    expect(questions).toEqual([direct]);
  });

  it('reports text that is not JSON', () => {
    const { questions, errors } = parseBatch('Here are your questions');
    expect(questions).toEqual([]);
    expect(errors.join()).toContain('not valid JSON');
  });

  it('reports JSON that breaks the schema', () => {
    const { questions, errors } = parseBatch(JSON.stringify([{ ...direct, slug: 'q-1' }]));
    expect(questions).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('checkBatch', () => {
  it('rejects a wrong count', () => {
    expect(checkBatch([direct], 'direct', deps).join()).toContain('1 direct questions, expected 16');
  });

  it('rejects a question of another category', () => {
    expect(checkBatch([comparison], 'direct', deps).join()).toContain('comparison-01: category is comparison');
  });

  it('rejects duplicate slugs', () => {
    const errors = checkBatch([direct, direct], 'direct', deps);
    expect(errors.join()).toContain('direct-01: duplicate slug');
  });
});

function makeBatch(template: GeneratedQuestion): GeneratedQuestion[] {
  return Array.from({ length: CATEGORY_COUNTS[template.category] }, (_, index) => ({
    ...template,
    slug: `${template.category}-${String(index + 1).padStart(2, '0')}`,
    question: `${template.question} (${String(index + 1)})`,
  }));
}

const generated = [direct, comparison, exception, noAnswer, otherRole].flatMap(makeBatch);

function withSplits(questions: GeneratedQuestion[]): EvalQuestion[] {
  return assignSplits(questions).map((question) => ({
    ...question,
    reviewed: false,
    datasetVersion: '2026.11-1',
  }));
}

function devCount(questions: EvalQuestion[], category: string): number {
  return questions.filter((question) => question.category === category && question.split === 'dev').length;
}

describe('assignSplits', () => {
  const questions = withSplits(generated);

  it('makes 12 dev and 28 test questions', () => {
    expect(questions.filter(({ split }) => split === 'dev')).toHaveLength(12);
    expect(questions.filter(({ split }) => split === 'test')).toHaveLength(28);
  });

  it('stratifies dev by category', () => {
    expect(devCount(questions, 'direct')).toBe(5);
    expect(devCount(questions, 'comparison')).toBe(2);
    expect(devCount(questions, 'exception')).toBe(2);
    expect(devCount(questions, 'no_answer')).toBe(2);
    expect(devCount(questions, 'other_role')).toBe(1);
  });

  it('gives the same split whatever the input order', () => {
    const splitOf = (list: EvalQuestion[]): string[] =>
      list.map(({ slug, split }) => `${slug}:${split}`).sort();
    expect(splitOf(withSplits([...generated].reverse()))).toEqual(splitOf(questions));
  });

  it('does not simply take the first questions of a category', () => {
    const firstFive = questions.filter(({ category }) => category === 'direct').slice(0, 5);
    expect(firstFive.every(({ split }) => split === 'dev')).toBe(false);
  });
});

describe('data/eval/questions.json', () => {
  it('passes every check against the committed registry', () => {
    const registry = registrySchema.parse(JSON.parse(readFileSync('data/registry.json', 'utf8')));
    const committed = evalQuestionsSchema.parse(JSON.parse(readFileSync('data/eval/questions.json', 'utf8')));
    const blocklist = parseBlocklist(readFileSync('data-gen/blocklist.txt', 'utf8'));
    expect(checkQuestionSet(committed, { catalog, facts: registry.facts, blocklist })).toEqual([]);
  });
});

describe('checkQuestionSet', () => {
  const questions = withSplits(generated);

  it('passes the full set', () => {
    expect(checkQuestionSet(questions, deps)).toEqual([]);
  });

  it('rejects a set with a missing question', () => {
    expect(checkQuestionSet(questions.slice(1), deps).join()).toContain('direct questions, expected 16');
  });

  it('rejects a split that was changed by hand', () => {
    const moved = questions.map((question) =>
      question.split === 'test' && question.slug === questions.find(({ split }) => split === 'test')?.slug
        ? { ...question, split: 'dev' as const }
        : question,
    );
    expect(checkQuestionSet(moved, deps).join()).toContain('dev questions, expected');
  });

  it('rejects the same question asked twice', () => {
    const repeated = questions.map((question, index) =>
      index === 1 ? { ...question, question: questions[0]!.question } : question,
    );
    expect(checkQuestionSet(repeated, deps).join()).toContain('repeats the question of');
  });
});
