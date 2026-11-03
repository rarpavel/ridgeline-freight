export type Inline =
  { type: 'text'; text: string } | { type: 'bold'; text: string } | { type: 'code'; text: string };

export type Block =
  { type: 'paragraph'; content: Inline[] } | { type: 'list'; ordered: boolean; items: Inline[][] };

const HTML_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG = /<\/?[a-zA-Z][^<>]*>|<![^<>]*>/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const LINK_DEFINITION = /^[ \t]*\[[^\]]+\]:[ \t]*(?:https?:|www\.).*$/gim;

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LINE_PREFIX = /^\s*(?:#{1,6}\s+|>\s?)/;
const BULLET_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const INLINE_MARK = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/;

/** Removes what the allowlist forbids. A link keeps its label, and a `[1](url)` stays a citation. */
function stripForbidden(source: string): string {
  let text = source;
  let previous: string;
  // Repeated, because removing a tag can join the text around it into a new one.
  do {
    previous = text;
    text = text.replace(HTML_BLOCK, '').replace(HTML_COMMENT, '').replace(HTML_TAG, '');
  } while (text !== previous);

  return text
    .replace(IMAGE, '')
    .replace(LINK, (_, label: string) => (/^\d+$/.test(label) ? `[${label}]` : label))
    .replace(LINK_DEFINITION, '');
}

function parseInline(text: string): Inline[] {
  return text
    .split(INLINE_MARK)
    .filter((part) => part !== '')
    .map((part): Inline => {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        return { type: 'bold', text: part.slice(2, -2) };
      }
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        return { type: 'code', text: part.slice(1, -1) };
      }
      return { type: 'text', text: part };
    });
}

/**
 * Parses an answer into paragraphs, lists, bold and inline code (SECURITY.md §5). The result has no
 * node for HTML, links or images, and it is rendered as React text, so nothing in it can become
 * markup. Whatever else Markdown would format, such as a heading mark or a fence, is reduced to text.
 */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] | null = null;

  function endParagraph() {
    if (paragraph) blocks.push({ type: 'paragraph', content: parseInline(paragraph.join('\n')) });
    paragraph = null;
  }

  function addListItem(ordered: boolean, text: string) {
    endParagraph();
    const last = blocks.at(-1);
    if (last?.type === 'list' && last.ordered === ordered) {
      last.items.push(parseInline(text));
    } else {
      blocks.push({ type: 'list', ordered, items: [parseInline(text)] });
    }
  }

  for (const rawLine of stripForbidden(source).split(/\r?\n/)) {
    if (FENCE.test(rawLine) || RULE.test(rawLine)) continue;
    const line = rawLine.replace(LINE_PREFIX, '');

    const bullet = BULLET_ITEM.exec(line);
    const ordered = ORDERED_ITEM.exec(line);
    if (bullet) {
      addListItem(false, bullet[1] ?? '');
    } else if (ordered) {
      addListItem(true, ordered[1] ?? '');
    } else if (line.trim() === '') {
      endParagraph();
    } else {
      paragraph = [...(paragraph ?? []), line];
    }
  }
  endParagraph();

  return blocks;
}
