import type { RateSheet } from '../../data-gen/schemas/rate-sheet';

type RateTable = RateSheet['tables'][number];

// A "|" or a line break would split a cell when the Markdown table is parsed back.
export function findCellErrors(table: RateTable): string[] {
  const errors: string[] = [];
  table.rows.forEach((row, index) => {
    if (row.length !== table.columns.length) {
      errors.push(`"${table.title}" row ${index + 1}: ${row.length} cells, expected ${table.columns.length}`);
    }
  });
  for (const cell of [...table.columns, ...table.rows.flat()]) {
    if (/[|\n]/.test(cell)) errors.push(`"${table.title}": remove "|" or the line break from cell "${cell}"`);
  }
  return errors;
}

export function renderMarkdownTable(table: RateTable): string {
  const errors = findCellErrors(table);
  if (errors.length > 0) throw new Error(errors.join('; '));
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [line(table.columns), line(table.columns.map(() => '---')), ...table.rows.map(line)].join('\n');
}

export function renderRateSheetMarkdown(sheet: RateSheet): string {
  const tables = sheet.tables.map((table) => `## ${table.title}\n\n${renderMarkdownTable(table)}`);
  const notes = sheet.notes.map((note, index) => `${index + 1}. ${note}`).join('\n');
  return [
    `# ${sheet.title}`,
    `Effective date: ${sheet.effectiveDate}`,
    sheet.intro,
    ...tables,
    ...(notes ? [`## Notes\n\n${notes}`] : []),
  ].join('\n\n');
}
