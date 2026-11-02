import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ILevelsOptions,
} from 'docx';
import JSZip from 'jszip';

export type ListItem = { ordered: boolean; level: 0 | 1; text: string };

export type Block =
  | { kind: 'title' | 'heading1' | 'heading2'; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' };

export type DocxOptions = { companyName: string; documentId: string };

// Letter with 1 inch margins, in twips.
const PAGE = { width: 12240, height: 15840, margin: 1440 };
const TEXT_WIDTH = PAGE.width - 2 * PAGE.margin;
// The docx library stamps the clock into core.xml and into every zip entry.
const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));

const HEADING_LINE = /^(#{1,3}) +(.+)$/;
const LIST_LINE = /^( *)(-|\d+\.) +(.+)$/;
const RULE_LINE = /^-{3,}$/;
const TABLE_LINE = /^\|.*\|$/;
const TABLE_SEPARATOR = /^\|( *:?-+:? *\|)+$/;

function lineAt(lines: string[], index: number): string {
  return lines[index] ?? '';
}

function isBlockStart(line: string): boolean {
  return (
    line === '' ||
    line.startsWith('#') ||
    LIST_LINE.test(line) ||
    RULE_LINE.test(line) ||
    TABLE_LINE.test(line)
  );
}

function splitRow(line: string): string[] {
  return line
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function parseTable(lines: string[], lineNumber: number): Block {
  const [headerLine = '', separator = '', ...rowLines] = lines;
  if (!TABLE_SEPARATOR.test(separator)) {
    throw new Error(`line ${lineNumber + 1}: a table needs a separator row under its header`);
  }
  const header = splitRow(headerLine);
  const rows = rowLines.map(splitRow);
  rows.forEach((row, index) => {
    if (row.length !== header.length) {
      throw new Error(
        `line ${lineNumber + index + 2}: ${row.length} cells, expected ${header.length}`,
      );
    }
  });
  return { kind: 'table', header, rows };
}

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/).map((line) => line.trimEnd());
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lineAt(lines, index);
    if (line === '') {
      index += 1;
      continue;
    }

    const heading = HEADING_LINE.exec(line);
    if (heading) {
      const [, hashes = '', text = ''] = heading;
      const kind = hashes.length === 1 ? 'title' : hashes.length === 2 ? 'heading1' : 'heading2';
      blocks.push({ kind, text: text.trim() });
      index += 1;
      continue;
    }

    if (line.startsWith('#')) throw new Error(`line ${index + 1}: unsupported heading "${line}"`);

    if (RULE_LINE.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    if (TABLE_LINE.test(line)) {
      const start = index;
      while (index < lines.length && TABLE_LINE.test(lineAt(lines, index))) index += 1;
      blocks.push(parseTable(lines.slice(start, index), start));
      continue;
    }

    if (LIST_LINE.test(line)) {
      const { items, next } = parseList(lines, index);
      blocks.push({ kind: 'list', items });
      index = next;
      continue;
    }

    // Every source line stays its own line: address and signature blocks have no trailing spaces.
    const paragraph: string[] = [];
    while (index < lines.length && !isBlockStart(lineAt(lines, index))) {
      paragraph.push(lineAt(lines, index));
      index += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }

  const titles = blocks.filter((block) => block.kind === 'title');
  if (blocks[0]?.kind !== 'title' || titles.length !== 1) {
    throw new Error('a document needs exactly one "# " title, on its first line');
  }
  return blocks;
}

function parseList(lines: string[], start: number): { items: ListItem[]; next: number } {
  const items: ListItem[] = [];
  let lastNumber = 0;
  let index = start;

  for (; index < lines.length; index += 1) {
    const line = lineAt(lines, index);
    const topOrdered = items[0]?.ordered;
    if (line === '') {
      // A blank line ends the list unless another item of it follows.
      let after = index + 1;
      while (after < lines.length && lineAt(lines, after) === '') after += 1;
      const [, indent, marker] = LIST_LINE.exec(lineAt(lines, after)) ?? [];
      const sameList = marker && (indent !== '' || (marker !== '-') === topOrdered);
      if (!sameList) break;
      continue;
    }

    const match = LIST_LINE.exec(line);
    if (!match) break;
    const [, indent = '', marker = '', text = ''] = match;
    const ordered = marker !== '-';
    const level = indent === '' ? 0 : 1;
    if (level === 0 && topOrdered !== undefined && ordered !== topOrdered) break;
    if (level === 0 && ordered) {
      const number = Number.parseInt(marker, 10);
      // Word numbers a list itself, so a gap in the source would silently change the numbers.
      if (number !== lastNumber + 1) {
        throw new Error(`line ${index + 1}: list item ${number} follows ${lastNumber}`);
      }
      lastNumber = number;
    }
    if (level === 1 && items.length === 0) {
      throw new Error(`line ${index + 1}: a list cannot start with an indented item`);
    }
    items.push({ ordered, level, text });
  }

  return { items, next: index };
}

function levelOf(ordered: boolean, level: 0 | 1): ILevelsOptions {
  const indent = { left: 360 * (level + 1), hanging: 360 };
  return ordered
    ? {
        level,
        format: LevelFormat.DECIMAL,
        text: `%${level + 1}.`,
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent } },
      }
    : {
        level,
        format: LevelFormat.BULLET,
        text: level === 0 ? '•' : '–',
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent } },
      };
}

// A Word level has one format, so each mix of top-level and nested items is its own definition.
const NUMBERING_CONFIG = [true, false].flatMap((top) =>
  [true, false].map((nested) => ({
    reference: `list-${top}-${nested}`,
    levels: [levelOf(top, 0), levelOf(nested, 1)],
  })),
);

function renderList(items: ListItem[], instance: number): Paragraph[] {
  const top = items[0]?.ordered ?? false;
  const nestedKinds = new Set(items.filter((item) => item.level === 1).map((item) => item.ordered));
  if (nestedKinds.size > 1) throw new Error(`mixed nested list under "${items[0]?.text}"`);
  const nested = nestedKinds.has(true) ? true : nestedKinds.has(false) ? false : top;
  return items.map(
    ({ level, text }) =>
      new Paragraph({
        text,
        numbering: { reference: `list-${top}-${nested}`, level, instance },
        spacing: { after: 60 },
      }),
  );
}

function renderTable(header: string[], rows: string[][]): Table {
  const columns = header.length;
  const cell = (text: string, bold: boolean): TableCell =>
    new TableCell({
      width: { size: 100 / columns, type: WidthType.PERCENTAGE },
      children: [new Paragraph({ children: [new TextRun({ text, bold })] })],
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: Array.from({ length: columns }, () => Math.floor(TEXT_WIDTH / columns)),
    rows: [
      new TableRow({ tableHeader: true, children: header.map((text) => cell(text, true)) }),
      ...rows.map(
        (row) => new TableRow({ children: row.map((text) => cell(text, false)) }),
      ),
    ],
  });
}

function renderBlocks(blocks: Block[]): (Paragraph | Table)[] {
  let listInstance = 0;
  return blocks.flatMap((block): (Paragraph | Table)[] => {
    switch (block.kind) {
      case 'title':
        return [new Paragraph({ text: block.text, heading: HeadingLevel.TITLE })];
      case 'heading1':
        return [new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_1 })];
      case 'heading2':
        return [new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_2 })];
      case 'paragraph':
        return block.lines.map(
          (text, index) =>
            new Paragraph({
              text,
              spacing: { after: index === block.lines.length - 1 ? 160 : 0 },
            }),
        );
      case 'list':
        listInstance += 1;
        return renderList(block.items, listInstance);
      case 'table':
        // Word needs a paragraph after a table, and it keeps the next block off the grid.
        return [renderTable(block.header, block.rows), new Paragraph({ text: '' })];
      case 'rule':
        return [
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } },
            spacing: { after: 160 },
          }),
        ];
    }
  });
}

// Same input, same bytes: rewrites the clock values and fixes the entry order.
async function normalizePackage(packed: Buffer): Promise<Buffer> {
  const source = await JSZip.loadAsync(packed);
  const target = new JSZip();
  const entries = Object.values(source.files)
    .filter((entry) => !entry.dir)
    .sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const entry of entries) {
    const content = await entry.async('nodebuffer');
    const data =
      entry.name === 'docProps/core.xml'
        ? content
            .toString('utf8')
            .replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*/g, `$1${FIXED_DATE.toISOString()}`)
        : content;
    target.file(entry.name, data, { date: FIXED_DATE, createFolders: false });
  }
  return target.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'DOS' });
}

export async function renderDocx(markdown: string, options: DocxOptions): Promise<Buffer> {
  const blocks = parseMarkdown(markdown);
  const [first] = blocks;
  const title = first?.kind === 'title' ? first.text : options.documentId;
  const document = new Document({
    title,
    creator: options.companyName,
    lastModifiedBy: options.companyName,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: NUMBERING_CONFIG },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE.width, height: PAGE.height },
            margin: {
              top: PAGE.margin,
              right: PAGE.margin,
              bottom: PAGE.margin,
              left: PAGE.margin,
            },
          },
        },
        headers: { default: new Header({ children: [new Paragraph(options.companyName)] }) },
        footers: { default: new Footer({ children: [new Paragraph(options.documentId)] }) },
        children: renderBlocks(blocks),
      },
    ],
  });
  return normalizePackage(await Packer.toBuffer(document));
}
