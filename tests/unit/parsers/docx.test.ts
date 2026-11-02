import { readFileSync } from 'node:fs';

import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { describe, expect, it, vi } from 'vitest';

import { parseDocx, type ParsedDocx } from '@/server/ingest/parsers/docx';

import { renderDocx } from '../../../scripts/data-gen/markdown-docx';

vi.mock('server-only', () => ({}));

const OPTIONS = { companyName: 'Ridgeline Freight, LLC', documentId: 'doc-1' };

async function parseMarkdown(markdown: string): Promise<ParsedDocx> {
  return parseDocx(await renderDocx(markdown, OPTIONS));
}

function sliceSections({ text, sections }: ParsedDocx): string[] {
  return sections.map(({ charStart, charEnd }) => text.slice(charStart, charEnd));
}

describe('parseDocx', () => {
  it('turns Title, Heading 1 and Heading 2 into #, ## and ###, and a table into a pipe table', async () => {
    const parsed = await parseMarkdown(
      '# Rate Sheet\n\n## 1. Rates\n\nIntro.\n\n### 1.1 Lanes\n\n| Lane | Rate |\n| --- | --- |\n| L-01 | $2.85 |\n',
    );
    expect(parsed.text).toBe(
      [
        '# Rate Sheet',
        '## 1. Rates',
        'Intro.',
        '### 1.1 Lanes',
        '| Lane | Rate |',
        '| --- | --- |',
        '| L-01 | $2.85 |',
      ].join('\n'),
    );
  });

  it('computes sections with offsets that slice out each heading and its body', async () => {
    const parsed = await parseMarkdown(
      '# Rate Sheet\n\n## 1. Rates\n\nIntro.\n\n### 1.1 Lanes\n\n| Lane | Rate |\n| --- | --- |\n| L-01 | $2.85 |\n\n## Notes\n\nLast line.\n',
    );
    expect(parsed.sections.map(({ ref, title }) => ({ ref, title }))).toEqual([
      { ref: '', title: 'Rate Sheet' },
      { ref: '1', title: 'Rates' },
      { ref: '1.1', title: 'Lanes' },
      { ref: '', title: 'Notes' },
    ]);
    expect(sliceSections(parsed)).toEqual([
      '# Rate Sheet',
      '## 1. Rates\nIntro.',
      '### 1.1 Lanes\n| Lane | Rate |\n| --- | --- |\n| L-01 | $2.85 |',
      '## Notes\nLast line.',
    ]);
    expect(parsed.sections.at(-1)?.charEnd).toBe(parsed.text.length);
  });

  it('writes bullets, numbers and nested items as list lines, and restarts numbering', async () => {
    const { text } = await parseMarkdown(
      '# T\n\n1. First\n   - nested a\n   - nested b\n2. Second\n\nBetween.\n\n1. Again\n\n- Bullet\n',
    );
    expect(text.split('\n').slice(1)).toEqual([
      '1. First',
      '   - nested a',
      '   - nested b',
      '2. Second',
      'Between.',
      '1. Again',
      '- Bullet',
    ]);
  });

  it('keeps every line of an address block and drops rules and empty paragraphs', async () => {
    const { text } = await parseMarkdown('# T\n\nStreet\nCity\n\n---\n\nAfter\n');
    expect(text).toBe('# T\nStreet\nCity\nAfter');
  });

  it('decodes escaped characters once and keeps angle brackets as text', async () => {
    const { text } = await parseMarkdown('# Fees & Charges\n\nBelow <5 pallets &amp; "quoted".\n');
    expect(text).toBe('# Fees & Charges\nBelow <5 pallets &amp; "quoted".');
  });

  it('escapes a pipe inside a table cell', async () => {
    // The Markdown renderer cannot produce this: a "|" there always starts a new cell.
    const row = (text: string) =>
      new TableRow({ children: [new TableCell({ children: [new Paragraph(text)] })] });
    const document = new Document({
      sections: [{ children: [new Table({ rows: [row('Head'), row('a|b')] })] }],
    });
    const { text } = await parseDocx(await Packer.toBuffer(document));
    expect(text).toBe('| Head |\n| --- |\n| a\\|b |');
  });

  it('leaves the page header and footer out of the text', async () => {
    const { text } = await parseMarkdown('# T\n\nBody.\n');
    expect(text).not.toContain('Ridgeline Freight, LLC');
    expect(text).not.toContain('doc-1');
  });

  it.each([
    ['contract', '### 2.1 Effective Date\nThis Agreement is effective 04/01/2026.'],
    [
      'rate-sheet',
      '| Lane | Origin | Destination | Miles | Rate per Mile |\n| --- | --- | --- | --- | --- |',
    ],
    ['policy', '# '],
  ])('reads the committed %s fixture', async (name, expected) => {
    const parsed = await parseDocx(readFileSync(`tests/fixtures/${name}.docx`));
    expect(parsed.text).toContain(expected);
    for (const slice of sliceSections(parsed)) expect(slice).toMatch(/^#{1,3} /);
  });

  it('gives the same result as the source Markdown for the contract fixture', async () => {
    const { text } = await parseDocx(readFileSync('tests/fixtures/contract.docx'));
    const expected = readFileSync('tests/fixtures/contract.md', 'utf8')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line !== '' && line !== '---')
      .join('\n');
    expect(text).toBe(expected);
  });
});
