import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCount, HEADLINE_METRICS } from '@/lib/eval-format';
import type { Metrics, RunMetrics } from '@/server/eval/metrics';

import { QUESTION_CATEGORIES } from '../../../data-gen/schemas/questions';

function MetricsRow({ name, metrics }: { name: string; metrics: Metrics | null | undefined }) {
  return (
    <TableRow data-testid={`metrics-${name}`}>
      <TableCell className="font-medium">{name}</TableCell>
      <TableCell>{formatCount(metrics?.questions)}</TableCell>
      {HEADLINE_METRICS.map(({ key, format }) => (
        <TableCell key={key}>{format(metrics)}</TableCell>
      ))}
    </TableRow>
  );
}

/** Always every category, so a category the run lacks reads as a gap, not as a shorter table. */
export function CategoryMetricsTable({ metrics }: { metrics: RunMetrics | null }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Category</TableHead>
          <TableHead>Questions</TableHead>
          {HEADLINE_METRICS.map(({ key, label }) => (
            <TableHead key={key}>{label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {QUESTION_CATEGORIES.map((category) => (
          <MetricsRow key={category} name={category} metrics={metrics?.byCategory?.[category]} />
        ))}
        <MetricsRow name="overall" metrics={metrics?.overall} />
      </TableBody>
    </Table>
  );
}
