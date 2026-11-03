import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate, HEADLINE_METRICS } from '@/lib/eval-format';
import type { EvalRunRow } from '@/server/db/queries/eval';

export function EvalRunsTable({ runs }: { runs: readonly EvalRunRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Label</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Split</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Prompt version</TableHead>
          <TableHead>Dataset version</TableHead>
          {HEADLINE_METRICS.map(({ key, label }) => (
            <TableHead key={key}>{label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell>
              <Link href={`/admin/eval/${run.id}`} className="font-medium underline">
                {run.label ?? 'Unlabeled run'}
              </Link>
              {!run.finishedAt && (
                <Badge variant="outline" className="ml-2">
                  Not finished
                </Badge>
              )}
            </TableCell>
            <TableCell>{formatDate(run.startedAt)}</TableCell>
            <TableCell>{run.split}</TableCell>
            <TableCell>{run.model}</TableCell>
            <TableCell>{run.promptVersion}</TableCell>
            <TableCell>{run.datasetVersion}</TableCell>
            {HEADLINE_METRICS.map(({ key, format }) => (
              <TableCell key={key}>{format(run.metrics?.overall)}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
