import type { DocumentSection } from '@/server/db/schema/documents';

export type CharRange = { charStart: number; charEnd: number };

/** What `/api/documents/:id` returns; `chunk` is null without a chunk of this document in the URL. */
export type ViewerDocument = {
  id: string;
  title: string;
  text: string;
  sections: DocumentSection[];
  chunk: CharRange | null;
};

export type ListItem = CharRange & { depth: number; marker: string; text: string };
export type TableRow = CharRange & { cells: string[] };

export type DocumentBlock =
  | (CharRange & { type: 'heading'; level: number; text: string })
  | (CharRange & { type: 'paragraph'; text: string })
  | { type: 'list'; items: ListItem[] }
  | { type: 'table'; header: TableRow; rows: TableRow[] };

const HEADING = /^(#{1,3}) (.*)$/;
const LIST_ITEM = /^((?: {3})*)(-|\d+\.) (.*)$/;
const TABLE_LINE = /^\| .* \|$|^\|\s+\|$/;
const SEPARATOR_CELL = '---';
// Three spaces per level, the indent the DOCX parser writes.
const INDENT_WIDTH = 3;

function parseTableRow(line: string, range: CharRange): TableRow {
  const cells = line
    .slice(2, -2)
    .split(/(?<!\\) \| /)
    .map((cell) => cell.replaceAll('\\|', '|').trim());
  return { ...range, cells };
}

function isSeparator({ cells }: TableRow): boolean {
  return cells.every((cell) => cell === SEPARATOR_CELL);
}

/**
 * Reads back the normalized text the DOCX parser writes: headings, paragraphs, lists and tables,
 * one line each, with the offsets of every line. Rendered as React text only, so nothing in a
 * document can become markup.
 */
export function parseDocumentBlocks(text: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let offset = 0;

  for (const line of text.split('\n')) {
    const range = { charStart: offset, charEnd: offset + line.length };
    offset = range.charEnd + 1;
    const last = blocks.at(-1);

    const heading = HEADING.exec(line);
    const item = LIST_ITEM.exec(line);
    if (heading) {
      const [, marks = '', title = ''] = heading;
      blocks.push({ ...range, type: 'heading', level: marks.length, text: title });
    } else if (item) {
      const [, indent = '', marker = '', itemText = ''] = item;
      const listItem = {
        ...range,
        depth: indent.length / INDENT_WIDTH,
        marker,
        text: itemText,
      };
      if (last?.type === 'list') last.items.push(listItem);
      else blocks.push({ type: 'list', items: [listItem] });
    } else if (TABLE_LINE.test(line)) {
      const row = parseTableRow(line, range);
      if (last?.type !== 'table') blocks.push({ type: 'table', header: row, rows: [] });
      else if (!isSeparator(row)) last.rows.push(row);
    } else if (line.trim() !== '') {
      blocks.push({ ...range, type: 'paragraph', text: line });
    }
  }
  return blocks;
}

export function overlaps(a: CharRange, b: CharRange): boolean {
  return a.charStart < b.charEnd && b.charStart < a.charEnd;
}

/** The section a character belongs to; sections never overlap and come in document order. */
export function sectionAt(sections: DocumentSection[], offset: number): DocumentSection | null {
  return sections.findLast((section) => section.charStart <= offset) ?? null;
}
