import { describe, expect, it, vi } from 'vitest';

import { buildMessages, RAG_SYSTEM_PROMPT_VERSION, type PromptChunk } from '@/server/rag/prompt';

vi.mock('server-only', () => ({}));

const TODAY = new Date('2026-03-05T12:00:00Z');

function chunk(overrides: Partial<PromptChunk> = {}): PromptChunk {
  return {
    documentTitle: 'Harbor Point Foods MSA',
    sectionRef: '4.3',
    sectionTitle: 'Late Delivery Penalties',
    contextPrefix: 'Harbor Point Foods MSA — 4. Service Levels › 4.3 Late Delivery Penalties',
    content: 'The credit is $250.00 per shipment.',
    ...overrides,
  };
}

function build(chunks: PromptChunk[], question = 'What is the credit?') {
  return buildMessages({ role: 'sales', today: TODAY, chunks, question });
}

describe('buildMessages', () => {
  it('returns one system and one user message, with no history', () => {
    expect(build([chunk()]).map((message) => message.role)).toEqual(['system', 'user']);
  });

  it('renders role and today into the system message', () => {
    const [system] = build([chunk()]);

    expect(system.content).toContain('The user has the role "sales"');
    expect(system.content).toContain("Today's date is 03/05/2026.");
    expect(system.content).not.toContain('{{');
  });

  it('keeps context and question out of the system message', () => {
    const [system] = build([chunk({ content: 'unique chunk text' })], 'unique question');

    expect(system.content).not.toContain('unique chunk text');
    expect(system.content).not.toContain('unique question');
  });

  it('formats today in UTC, whatever the time of day', () => {
    const [system] = buildMessages({
      role: 'hr',
      today: new Date('2026-12-31T23:59:59Z'),
      chunks: [chunk()],
      question: 'q',
    });

    expect(system.content).toContain("Today's date is 12/31/2026.");
  });

  it('numbers 8 chunks as 8 delimited blocks, in order, with the question last', () => {
    const chunks = Array.from({ length: 8 }, (_, index) => chunk({ content: `body ${index + 1}` }));
    const [, user] = build(chunks, 'What is the credit?');

    const headers = user.content.match(/^\[\d+\] Document: .+ · Section .+$/gm) ?? [];
    expect(headers).toHaveLength(8);
    expect(headers.map((header) => header.split(' ')[0])).toEqual(
      chunks.map((_, index) => `[${index + 1}]`),
    );
    expect(user.content.match(/^<<<$/gm)).toHaveLength(8);
    expect(user.content.match(/^>>>$/gm)).toHaveLength(8);
    chunks.forEach((_, index) => {
      expect(user.content).toContain(`<<<\nbody ${index + 1}\n>>>`);
    });
    expect(user.content.endsWith('What is the credit?')).toBe(true);
  });

  it('matches the format of RAG_PIPELINE §2.4', () => {
    const [, user] = build([chunk()], 'What is the credit?');

    expect(user.content).toBe(
      [
        'CONTEXT PASSAGES (the only information you may use):',
        '[1] Document: Harbor Point Foods MSA · Section 4.3 Late Delivery Penalties',
        '<<<',
        'The credit is $250.00 per shipment.',
        '>>>',
        '',
        'QUESTION: What is the credit?',
      ].join('\n'),
    );
  });

  it('leaves out section parts the chunk does not have', () => {
    const [, user] = build([
      chunk({ sectionRef: null }),
      chunk({ sectionRef: null, sectionTitle: null }),
    ]);

    expect(user.content).toContain(
      '[1] Document: Harbor Point Foods MSA · Section Late Delivery Penalties\n',
    );
    expect(user.content).toContain('[2] Document: Harbor Point Foods MSA\n');
  });

  it('adds the table header rows of a later table part to its block', () => {
    const tableHeader = '| Lane | Rate |\n| --- | --- |';
    const [, user] = build([
      chunk({
        contextPrefix: `Rate Sheet — 2. Lanes\n${tableHeader}`,
        content: '| CHI-DAL | $1,250.00 |',
      }),
    ]);

    expect(user.content).toContain(`<<<\n${tableHeader}\n| CHI-DAL | $1,250.00 |\n>>>`);
    expect(user.content).not.toContain('Rate Sheet — 2. Lanes');
  });

  it('does not add the context prefix to an ordinary chunk', () => {
    const [, user] = build([chunk()]);

    expect(user.content).not.toContain('4. Service Levels ›');
  });

  it('cuts the question to 500 characters', () => {
    const [, user] = build([chunk()], `${'a'.repeat(500)}TAIL`);

    expect(user.content.endsWith(`QUESTION: ${'a'.repeat(500)}`)).toBe(true);
  });

  it('keeps a question of exactly 500 characters whole', () => {
    const question = 'b'.repeat(500);
    const [, user] = build([chunk()], question);

    expect(user.content.endsWith(`QUESTION: ${question}`)).toBe(true);
  });

  it('inserts chunk text literally, without rendering placeholders in it', () => {
    const [, user] = build([chunk({ content: '{{role}} and $& stay as written' })]);

    expect(user.content).toContain('{{role}} and $& stay as written');
  });
});

describe('RAG_SYSTEM_PROMPT_VERSION', () => {
  it('has the form recorded in traces', () => {
    expect(RAG_SYSTEM_PROMPT_VERSION).toMatch(/^rag-system@v2#[0-9a-f]{8}$/);
  });
});
