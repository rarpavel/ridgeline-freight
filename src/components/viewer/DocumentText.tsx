import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  overlaps,
  parseDocumentBlocks,
  type CharRange,
  type TableRow as DocumentTableRow,
} from '@/lib/document-blocks';
import { cn } from '@/lib/utils';

const CITED_CLASS = 'scroll-mt-32 bg-amber-100 dark:bg-amber-500/25';
const HEADING_CLASS: Record<number, string> = {
  1: 'text-2xl font-semibold',
  2: 'mt-4 text-xl font-semibold',
  3: 'mt-2 text-base font-semibold',
};

function citedProps(line: CharRange, chunk: CharRange | null) {
  return chunk && overlaps(line, chunk)
    ? { 'data-cited': true, className: CITED_CLASS }
    : { className: undefined };
}

function DocumentTable({
  header,
  rows,
  chunk,
}: {
  header: DocumentTableRow;
  rows: DocumentTableRow[];
  chunk: CharRange | null;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow {...citedProps(header, chunk)}>
          {header.cells.map((cell, index) => (
            <TableHead key={index}>{cell}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.charStart} {...citedProps(row, chunk)}>
            {row.cells.map((cell, index) => (
              <TableCell key={index}>{cell}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Renders the normalized text as React text only (ADR-0011). Whole lines are highlighted: a chunk
 * covers whole lines, apart from the overlap it can share with the chunk before it.
 */
export function DocumentText({ text, chunk }: { text: string; chunk: CharRange | null }) {
  return (
    <div className="flex flex-col gap-3 leading-7 break-words">
      {parseDocumentBlocks(text).map((block, index) => {
        switch (block.type) {
          case 'heading': {
            const Heading = block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4';
            const { className, ...cited } = citedProps(block, chunk);
            return (
              <Heading key={index} {...cited} className={cn(HEADING_CLASS[block.level], className)}>
                {block.text}
              </Heading>
            );
          }
          case 'paragraph':
            return (
              <p key={index} {...citedProps(block, chunk)}>
                {block.text}
              </p>
            );
          case 'list':
            return (
              <ul key={index} className="flex flex-col gap-1">
                {block.items.map((item) => {
                  const { className, ...cited } = citedProps(item, chunk);
                  return (
                    <li
                      key={item.charStart}
                      {...cited}
                      className={cn('flex gap-2', className)}
                      style={{ marginLeft: `${item.depth * 1.5}rem` }}
                    >
                      <span className="text-muted-foreground shrink-0">
                        {item.marker === '-' ? '•' : item.marker}
                      </span>
                      <span className="min-w-0">{item.text}</span>
                    </li>
                  );
                })}
              </ul>
            );
          case 'table':
            return (
              <DocumentTable key={index} header={block.header} rows={block.rows} chunk={chunk} />
            );
        }
      })}
    </div>
  );
}
