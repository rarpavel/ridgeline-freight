import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AnswerText } from '@/components/chat/AnswerText';
import type { ChatCitation } from '@/lib/sse';

const citation: ChatCitation = {
  n: 1,
  chunkId: 'chunk-1',
  documentId: 'doc-1',
  title: 'Detention SOP',
  sectionRef: '2',
};

function render(text: string, citations: ChatCitation[] | null = [citation]): string {
  return renderToStaticMarkup(createElement(AnswerText, { text, citations }));
}

function linkTargets(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('AnswerText', () => {
  it('renders an image tag as nothing and the citation next to it as a chip', () => {
    const html = render('<img src=x onerror=alert(1)> [1]');

    expect(html).not.toMatch(/<img|onerror|alert/);
    expect(html).toContain('[1] Detention SOP · §2</a>');
    expect(linkTargets(html)).toEqual(['/documents/doc-1?chunk=chunk-1']);
  });

  it.each([
    ['a script', '<script>alert(1)</script>Fee is due [1].', /<script|alert/],
    ['a javascript link', 'See [terms](javascript:alert(1)) [1].', /javascript:/],
    ['a link', 'See [terms](https://evil.example) [1].', /evil\.example/],
    ['an image', '![pixel](https://evil.example/a.png) Fee [1].', /<img|evil\.example/],
  ])('links only to the viewer when the answer holds %s', (_, text, forbidden) => {
    const html = render(text);

    expect(html).not.toMatch(forbidden);
    expect(linkTargets(html)).toEqual(['/documents/doc-1?chunk=chunk-1']);
  });

  it('escapes a tag that was never closed, so it stays text', () => {
    const html = render('Fee <img src=x onerror=alert(1) [1]');

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('leaves a citation with no matching source as plain text', () => {
    const html = render('Fee is due [2].');

    expect(html).toContain('[2]');
    expect(linkTargets(html)).toEqual([]);
  });
});
