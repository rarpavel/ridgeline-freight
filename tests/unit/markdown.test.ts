import { describe, expect, it } from 'vitest';

import { parseMarkdown, type Block } from '@/lib/markdown';

function paragraph(text: string): Block {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

describe('parseMarkdown: forbidden content', () => {
  it.each([
    ['a tag, keeping its text', 'Fee is <b>due</b> now.', 'Fee is due now.'],
    ['an attribute handler', 'Fee <img src=x onerror=alert(1)> due.', 'Fee  due.'],
    ['a script with its content', 'Fee <script>alert(1)</script>due.', 'Fee due.'],
    ['a style with its content', 'Fee <style>p{color:red}</style>due.', 'Fee due.'],
    ['a comment', 'Fee <!-- hidden -->due.', 'Fee due.'],
    ['a tag rebuilt by removing another', 'Fee <scr<b>ipt>due.', 'Fee due.'],
    ['an autolink', 'Fee <https://evil.example> due.', 'Fee  due.'],
    ['an image', 'Fee ![pixel](https://evil.example/a.png)due.', 'Fee due.'],
    [
      'a link, keeping its label',
      'See [the terms](https://evil.example) now.',
      'See the terms now.',
    ],
    ['a javascript link', 'See [terms](javascript:alert(1)) now.', 'See terms) now.'],
  ])('removes %s', (_, source, expected) => {
    expect(parseMarkdown(source)).toEqual([paragraph(expected)]);
  });

  it('drops a link definition line', () => {
    expect(parseMarkdown('Fee due.\n\n[terms]: https://evil.example')).toEqual([
      paragraph('Fee due.'),
    ]);
  });

  it('keeps a citation that was written as a link', () => {
    expect(parseMarkdown('Fee is $75 [1](https://evil.example).')).toEqual([
      paragraph('Fee is $75 [1].'),
    ]);
  });

  it('strips inside bold and inline code too', () => {
    expect(parseMarkdown('**<i>Net</i> 30** and `<b>x</b>`')).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'bold', text: 'Net 30' },
          { type: 'text', text: ' and ' },
          { type: 'code', text: 'x' },
        ],
      },
    ]);
  });

  it('never produces a node outside the allowlist', () => {
    const source = '# Title\n\n<div>x</div>\n\n[a](b) ![c](d)\n\n> quote\n\n```\ncode\n```\n\n---';
    const types = parseMarkdown(source).flatMap((block) =>
      block.type === 'paragraph'
        ? [block.type, ...block.content.map(({ type }) => type)]
        : [block.type, ...block.items.flat().map(({ type }) => type)],
    );

    expect(new Set(types)).toEqual(new Set(['paragraph', 'text']));
  });

  it('leaves comparisons that are not tags alone', () => {
    expect(parseMarkdown('Under 5 < 10 lbs and over 20 > 10 lbs.')).toEqual([
      paragraph('Under 5 < 10 lbs and over 20 > 10 lbs.'),
    ]);
  });
});

describe('parseMarkdown: allowed content', () => {
  it('splits paragraphs on a blank line and keeps single line breaks', () => {
    expect(parseMarkdown('One\ntwo\n\nThree')).toEqual([paragraph('One\ntwo'), paragraph('Three')]);
  });

  it('parses bold and inline code around plain text', () => {
    expect(parseMarkdown('The **detention** fee is `DET-1` [1].')).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'The ' },
          { type: 'bold', text: 'detention' },
          { type: 'text', text: ' fee is ' },
          { type: 'code', text: 'DET-1' },
          { type: 'text', text: ' [1].' },
        ],
      },
    ]);
  });

  it('leaves an unfinished bold as text, as it looks mid-stream', () => {
    expect(parseMarkdown('The **deten')).toEqual([paragraph('The **deten')]);
  });

  it('parses bullet and ordered lists, and joins items split by blank lines', () => {
    expect(parseMarkdown('Fees:\n- one\n\n- **two**\n\n1. first\n2) second')).toEqual([
      paragraph('Fees:'),
      {
        type: 'list',
        ordered: false,
        items: [[{ type: 'text', text: 'one' }], [{ type: 'bold', text: 'two' }]],
      },
      {
        type: 'list',
        ordered: true,
        items: [[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]],
      },
    ]);
  });

  it('returns nothing for empty text', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});
