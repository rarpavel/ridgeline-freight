import 'server-only';

import mammoth from 'mammoth';

import type { DocumentSection } from '@/server/db/schema/documents';

export type ParsedDocx = { text: string; sections: DocumentSection[] };

type HtmlNode = string | HtmlElement;
type HtmlElement = { tag: string; children: HtmlNode[] };
type Line = { text: string; headingLevel?: number };

// The renderer writes "# " as Title, "## " as Heading 1 and "### " as Heading 2.
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Heading 1'] => h2:fresh",
  "p[style-name='Heading 2'] => h3:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
];

const HEADING_LEVELS: Record<string, number> = { h1: 1, h2: 2, h3: 3 };
const VOID_TAGS = new Set(['br', 'img']);
const SPACED_TAGS = new Set(['br', 'p']);
const HTML_TOKEN = /<(\/?)([a-z0-9]+)[^>]*>|[^<]+/g;
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
};
const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)\.? +(.+)$/;
// Three spaces line a nested item up under the text of "1. ", the same as the source Markdown.
const LIST_INDENT = '   ';

// Mammoth writes well-formed HTML and escapes these four characters in text, so a tokenizer is enough.
function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { tag: 'root', children: [] };
  const stack = [root];
  for (const match of html.matchAll(HTML_TOKEN)) {
    const [token, closing, tag] = match;
    const parent = stack.at(-1) ?? root;
    if (tag === undefined) {
      parent.children.push(
        token.replace(/&(?:amp|lt|gt|quot);/g, (entity) => HTML_ENTITIES[entity] ?? entity),
      );
    } else if (closing) {
      stack.pop();
    } else {
      const element: HtmlElement = { tag, children: [] };
      parent.children.push(element);
      if (!VOID_TAGS.has(tag)) stack.push(element);
    }
  }
  return root;
}

function rawText(node: HtmlNode): string {
  if (typeof node === 'string') return node;
  const text = node.children.map(rawText).join('');
  return SPACED_TAGS.has(node.tag) ? ` ${text} ` : text;
}

function inlineText(nodes: HtmlNode[]): string {
  return nodes.map(rawText).join('').replace(/\s+/g, ' ').trim();
}

function childElements(element: HtmlElement, tags: string[]): HtmlElement[] {
  return element.children.flatMap((child) => {
    if (typeof child === 'string') return [];
    return tags.includes(child.tag) ? [child] : childElements(child, tags);
  });
}

function listLines(list: HtmlElement, depth: number): Line[] {
  const lines: Line[] = [];
  let number = 0;
  for (const item of list.children) {
    if (typeof item === 'string' || item.tag !== 'li') continue;
    number += 1;
    const isNested = (child: HtmlNode) =>
      typeof child !== 'string' && (child.tag === 'ul' || child.tag === 'ol');
    const marker = list.tag === 'ol' ? `${number}.` : '-';
    const text = inlineText(item.children.filter((child) => !isNested(child)));
    lines.push({ text: `${LIST_INDENT.repeat(depth)}${marker} ${text}` });
    for (const nested of item.children.filter(isNested)) {
      lines.push(...listLines(nested as HtmlElement, depth + 1));
    }
  }
  return lines;
}

function tableLines(table: HtmlElement): Line[] {
  const rows = childElements(table, ['tr']).map((row) =>
    childElements(row, ['th', 'td']).map((cell) => inlineText(cell.children).replace(/\|/g, '\\|')),
  );
  const [header, ...body] = rows;
  if (!header) return [];
  const separator = header.map(() => '---');
  return [header, separator, ...body].map((cells) => ({ text: `| ${cells.join(' | ')} |` }));
}

function blockLines(node: HtmlNode): Line[] {
  if (typeof node === 'string') return [];
  const headingLevel = HEADING_LEVELS[node.tag];
  if (headingLevel !== undefined) {
    return [{ text: `${'#'.repeat(headingLevel)} ${inlineText(node.children)}`, headingLevel }];
  }
  if (node.tag === 'ul' || node.tag === 'ol') return listLines(node, 0);
  if (node.tag === 'table') return tableLines(node);
  const text = inlineText(node.children);
  return text === '' ? [] : [{ text }];
}

function toSection({ text, headingLevel = 0 }: Line, charStart: number): DocumentSection {
  const heading = text.slice(headingLevel + 1);
  const [, ref, title] = NUMBERED_HEADING.exec(heading) ?? [];
  return { ref: ref ?? '', title: title ?? heading, charStart, charEnd: charStart };
}

// A section runs from its heading to the line before the next heading of any level, so sections
// never overlap and the text before the first "##" belongs to the title.
function joinLines(lines: Line[]): ParsedDocx {
  const sections: DocumentSection[] = [];
  let offset = 0;
  for (const line of lines) {
    if (line.headingLevel !== undefined) sections.push(toSection(line, offset));
    offset += line.text.length;
    const current = sections.at(-1);
    if (current) current.charEnd = offset;
    offset += 1;
  }
  return { text: lines.map((line) => line.text).join('\n'), sections };
}

export async function parseDocx(buffer: Buffer): Promise<ParsedDocx> {
  const { value: html } = await mammoth.convertToHtml({ buffer }, { styleMap: STYLE_MAP });
  return joinLines(parseHtml(html).children.flatMap(blockLines));
}
