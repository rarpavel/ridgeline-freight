import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { catalogSchema } from '../../data-gen/schemas/catalog';
import { parseMarkdown, renderDocx } from '../../scripts/data-gen/markdown-docx';

const OPTIONS = { companyName: 'Ridgeline Freight, LLC', documentId: 'doc-1' };

async function readPart(docx: Buffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(docx);
  const part = zip.file(name);
  if (!part) throw new Error(`${name} is not in the package`);
  return part.async('string');
}

async function findPart(docx: Buffer, pattern: RegExp): Promise<string> {
  const zip = await JSZip.loadAsync(docx);
  const name = Object.keys(zip.files).find((file) => pattern.test(file));
  if (!name) throw new Error(`no part matches ${pattern}`);
  return readPart(docx, name);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseMarkdown', () => {
  it('maps headings to title, heading1 and heading2', () => {
    expect(parseMarkdown('# T\n\n## A\ntext\n\n### B\n')).toEqual([
      { kind: 'title', text: 'T' },
      { kind: 'heading1', text: 'A' },
      { kind: 'paragraph', lines: ['text'] },
      { kind: 'heading2', text: 'B' },
    ]);
  });

  it('keeps every source line of a block, with or without trailing spaces', () => {
    expect(parseMarkdown('# T\n\nStreet  \nCity\nDate: ____\n')[1]).toEqual({
      kind: 'paragraph',
      lines: ['Street', 'City', 'Date: ____'],
    });
  });

  it('parses bullets, numbers and nested items as one list', () => {
    expect(parseMarkdown('# T\n\n1. A\n   - a\n2. B\n   1. b\n')[1]).toEqual({
      kind: 'list',
      items: [
        { ordered: true, level: 0, text: 'A' },
        { ordered: false, level: 1, text: 'a' },
        { ordered: true, level: 0, text: 'B' },
        { ordered: true, level: 1, text: 'b' },
      ],
    });
  });

  it('keeps a list together across blank lines', () => {
    const blocks = parseMarkdown('# T\n\n1. A\n   1. a\n\n2. B\n\nAfter\n');
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toMatchObject({ kind: 'list' });
    expect(blocks[2]).toEqual({ kind: 'paragraph', lines: ['After'] });
  });

  it('starts a new list when the top-level kind changes', () => {
    const kinds = parseMarkdown('# T\n\n- a\n\n1. b\n').map((block) => block.kind);
    expect(kinds).toEqual(['title', 'list', 'list']);
  });

  it('rejects a gap in the numbers, which Word would renumber', () => {
    expect(() => parseMarkdown('# T\n\n1. A\n3. B\n')).toThrow(/item 3 follows 1/);
  });

  it('parses a table with its header row', () => {
    expect(parseMarkdown('# T\n\n| A | B |\n| --- | --- |\n| 1 | $2.00 |\n')[1]).toEqual({
      kind: 'table',
      header: ['A', 'B'],
      rows: [['1', '$2.00']],
    });
  });

  it('rejects a table row with the wrong number of cells', () => {
    expect(() => parseMarkdown('# T\n\n| A | B |\n| --- | --- |\n| 1 |\n')).toThrow(/1 cells/);
  });

  it('rejects a table without a separator row', () => {
    expect(() => parseMarkdown('# T\n\n| A | B |\n| 1 | 2 |\n')).toThrow(/separator/);
  });

  it('treats --- as a rule and a line of underscores as text', () => {
    expect(parseMarkdown('# T\n\n--- \n\n_____\n').slice(1)).toEqual([
      { kind: 'rule' },
      { kind: 'paragraph', lines: ['_____'] },
    ]);
  });

  it('needs exactly one title, first', () => {
    expect(() => parseMarkdown('## A\n')).toThrow(/title/);
    expect(() => parseMarkdown('# A\n\n# B\n')).toThrow(/title/);
  });

  it('rejects a heading level the renderer has no style for', () => {
    expect(() => parseMarkdown('# T\n\n#### Deep\n')).toThrow(/unsupported heading/);
    expect(() => parseMarkdown('# T\n\nText\n#### Deep\n')).toThrow(/line 4: unsupported heading/);
  });

  it('parses every document in the corpus', () => {
    const catalog = catalogSchema.parse(JSON.parse(readFileSync('data/catalog.json', 'utf8')));
    expect(readdirSync('data/generated/md')).toHaveLength(catalog.length);
    for (const { slug, title } of catalog) {
      const markdown = readFileSync(path.join('data/generated/md', `${slug}.md`), 'utf8');
      expect(parseMarkdown(markdown)[0], slug).toEqual({ kind: 'title', text: title });
    }
  });
});

describe('renderDocx', () => {
  it('uses real Title and Heading styles', async () => {
    const docx = await renderDocx('# T\n\n## A\n\n### B\n', OPTIONS);
    const xml = await readPart(docx, 'word/document.xml');
    expect(xml).toContain('<w:pStyle w:val="Title"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>');
    const styles = await readPart(docx, 'word/styles.xml');
    expect(styles).toContain('<w:name w:val="Heading 1"/>');
  });

  it('marks the header row of a table and keeps all columns', async () => {
    const docx = await renderDocx(
      '# T\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n',
      OPTIONS,
    );
    const xml = await readPart(docx, 'word/document.xml');
    expect(xml.match(/<w:tblHeader\/>/g)).toHaveLength(1);
    expect(xml.match(/<w:tc>/g)).toHaveLength(6);
    expect(xml.match(/<w:gridCol /g)).toHaveLength(3);
  });

  it('gives each list its own numbering instance, so numbers restart', async () => {
    const docx = await renderDocx('# T\n\n1. A\n\nText\n\n1. B\n', OPTIONS);
    const xml = await readPart(docx, 'word/document.xml');
    const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toEqual(ids[1]);
  });

  it('writes the company name in the header, the id in the footer and Letter size', async () => {
    const docx = await renderDocx('# T\n', OPTIONS);
    expect(await findPart(docx, /word\/header\d*\.xml/)).toContain('Ridgeline Freight, LLC');
    expect(await findPart(docx, /word\/footer\d*\.xml/)).toContain('doc-1');
    const xml = await readPart(docx, 'word/document.xml');
    expect(xml).toMatch(/<w:pgSz [^>]*w:w="12240"[^>]*w:h="15840"/);
  });

  it('renders a --- rule without its characters in the text', async () => {
    const xml = await readPart(await renderDocx('# T\n\n---\n', OPTIONS), 'word/document.xml');
    expect(xml).not.toContain('---');
    expect(xml).toContain('<w:pBdr>');
  });

  it('produces the same bytes at another time and after other documents', async () => {
    const markdown = readFileSync('tests/fixtures/contract.md', 'utf8');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T10:00:00Z'));
    const first = await renderDocx(markdown, OPTIONS);
    await renderDocx(readFileSync('tests/fixtures/policy.md', 'utf8'), OPTIONS);
    vi.setSystemTime(new Date('2031-09-15T23:59:59Z'));
    const second = await renderDocx(markdown, OPTIONS);
    expect(second.equals(first)).toBe(true);
  });

  it('leaves no clock value or library default in the metadata', async () => {
    const core = await readPart(await renderDocx('# T\n', OPTIONS), 'docProps/core.xml');
    expect(core).toContain('2026-01-01T00:00:00.000Z');
    expect(core).toContain('<dc:creator>Ridgeline Freight, LLC</dc:creator>');
    expect(core).not.toContain('Un-named');
  });

  it.each(['contract', 'rate-sheet', 'policy'])('keeps the %s fixture in sync', async (name) => {
    const markdown = readFileSync(`tests/fixtures/${name}.md`, 'utf8');
    const docx = await renderDocx(markdown, {
      companyName: OPTIONS.companyName,
      documentId: `fixture-${name}`,
    });
    expect(docx.equals(readFileSync(`tests/fixtures/${name}.docx`))).toBe(true);
  });
});
