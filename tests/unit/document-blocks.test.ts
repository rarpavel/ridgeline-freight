import { describe, expect, it } from 'vitest';

import { overlaps, parseDocumentBlocks, sectionAt } from '@/lib/document-blocks';

describe('parseDocumentBlocks', () => {
  it('reads headings of every level and paragraphs', () => {
    const blocks = parseDocumentBlocks('# Title\nIntro line\n## 1. Scope\n### 1.1 Terms');

    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: 'Title', charStart: 0, charEnd: 7 },
      { type: 'paragraph', text: 'Intro line', charStart: 8, charEnd: 18 },
      { type: 'heading', level: 2, text: '1. Scope', charStart: 19, charEnd: 30 },
      { type: 'heading', level: 3, text: '1.1 Terms', charStart: 31, charEnd: 44 },
    ]);
  });

  it('keeps list items together, with their markers and depth', () => {
    const blocks = parseDocumentBlocks('1. First\n   - Nested\n2. Second');

    expect(blocks).toEqual([
      {
        type: 'list',
        items: [
          { depth: 0, marker: '1.', text: 'First', charStart: 0, charEnd: 8 },
          { depth: 1, marker: '-', text: 'Nested', charStart: 9, charEnd: 20 },
          { depth: 0, marker: '2.', text: 'Second', charStart: 21, charEnd: 30 },
        ],
      },
    ]);
  });

  it('reads a table into a header and rows, without the separator line', () => {
    const blocks = parseDocumentBlocks('| Lane | Rate |\n| --- | --- |\n| chi-mke | $3.10 |');

    expect(blocks).toEqual([
      {
        type: 'table',
        header: { cells: ['Lane', 'Rate'], charStart: 0, charEnd: 15 },
        rows: [{ cells: ['chi-mke', '$3.10'], charStart: 30, charEnd: 49 }],
      },
    ]);
  });

  it('keeps an escaped pipe and an empty cell inside their cells', () => {
    const [table] = parseDocumentBlocks('| A | B | C |\n| --- | --- | --- |\n| x \\| y |  | z |');

    expect(table).toMatchObject({ rows: [{ cells: ['x | y', '', 'z'] }] });
  });

  it('starts a new block after a line of another kind', () => {
    const types = parseDocumentBlocks('- a\ntext\n- b\n| H |\n| --- |\ntext').map((b) => b.type);

    expect(types).toEqual(['list', 'paragraph', 'list', 'table', 'paragraph']);
  });

  it('gives offsets that map back to the source text', () => {
    const text = '# Title\n\nBody with text\n- item';
    const blocks = parseDocumentBlocks(text);

    const paragraph = blocks[1];
    expect(paragraph?.type).toBe('paragraph');
    if (paragraph?.type !== 'paragraph') return;
    expect(text.slice(paragraph.charStart, paragraph.charEnd)).toBe('Body with text');
  });

  it('treats markup in a document as plain text', () => {
    const [block] = parseDocumentBlocks('<script>alert(1)</script> [link](http://example.com)');

    expect(block).toMatchObject({
      type: 'paragraph',
      text: '<script>alert(1)</script> [link](http://example.com)',
    });
  });
});

describe('overlaps', () => {
  const chunk = { charStart: 10, charEnd: 20 };

  it('is true for a line that shares a character with the chunk', () => {
    expect(overlaps({ charStart: 5, charEnd: 11 }, chunk)).toBe(true);
    expect(overlaps({ charStart: 19, charEnd: 30 }, chunk)).toBe(true);
    expect(overlaps({ charStart: 12, charEnd: 15 }, chunk)).toBe(true);
  });

  it('is false for a line that only touches the chunk', () => {
    expect(overlaps({ charStart: 0, charEnd: 10 }, chunk)).toBe(false);
    expect(overlaps({ charStart: 20, charEnd: 25 }, chunk)).toBe(false);
  });
});

describe('sectionAt', () => {
  const sections = [
    { ref: '', title: 'Title', charStart: 0, charEnd: 9 },
    { ref: '1', title: 'Scope', charStart: 10, charEnd: 19 },
    { ref: '1.1', title: 'Terms', charStart: 20, charEnd: 40 },
  ];

  it('finds the section around an offset', () => {
    expect(sectionAt(sections, 25)?.ref).toBe('1.1');
    expect(sectionAt(sections, 10)?.ref).toBe('1');
  });

  it('is null before the first section and without sections', () => {
    expect(sectionAt(sections.slice(1), 3)).toBeNull();
    expect(sectionAt([], 3)).toBeNull();
  });
});
