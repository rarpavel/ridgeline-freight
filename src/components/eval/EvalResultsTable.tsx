import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCount, formatFlag, formatMs, formatScore } from '@/lib/eval-format';
import type { EvalResultRow } from '@/server/db/queries/eval';

const TEXT_CELL = 'min-w-64 align-top whitespace-pre-wrap';
const VALUE_CELL = 'align-top';

export function EvalResultsTable({ results }: { results: readonly EvalResultRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Category</TableHead>
          <TableHead>Question</TableHead>
          <TableHead>Expected</TableHead>
          <TableHead>Answer</TableHead>
          <TableHead>Refused</TableHead>
          <TableHead>Hit</TableHead>
          <TableHead>Correctness</TableHead>
          <TableHead>Faithfulness</TableHead>
          <TableHead>Latency</TableHead>
          <TableHead>Trace</TableHead>
          <TableHead>Rationale</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {results.map(
          ({
            questionId,
            category,
            question,
            expectedAnswer,
            answer,
            refused,
            scores,
            latencyMs,
            traceId,
            judgeRationale,
          }) => (
            <TableRow key={questionId} data-testid="result-row">
              <TableCell className={VALUE_CELL}>{category}</TableCell>
              <TableCell className={TEXT_CELL}>{question}</TableCell>
              <TableCell className={TEXT_CELL}>{expectedAnswer ?? '—'}</TableCell>
              <TableCell className={TEXT_CELL}>{answer}</TableCell>
              <TableCell className={VALUE_CELL}>{formatFlag(refused)}</TableCell>
              <TableCell className={VALUE_CELL}>{formatFlag(scores.retrievalHit)}</TableCell>
              <TableCell className={VALUE_CELL}>
                {formatCount(scores.correctness)}
                {scores.judgeError && (
                  <Badge variant="destructive" className="ml-2">
                    Judge error
                  </Badge>
                )}
                {scores.needsReview && (
                  <Badge variant="outline" className="ml-2">
                    Needs review
                  </Badge>
                )}
              </TableCell>
              <TableCell className={VALUE_CELL}>{formatScore(scores.faithfulness)}</TableCell>
              <TableCell className={VALUE_CELL}>{formatMs(latencyMs)}</TableCell>
              <TableCell className={VALUE_CELL}>
                {/* A plain link: the route answers with JSON, not a page for the router. */}
                {traceId ? (
                  <a href={`/api/traces/${traceId}`} className="underline">
                    Trace
                  </a>
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell className={TEXT_CELL}>
                {judgeRationale ? (
                  <details>
                    <summary className="cursor-pointer">Show</summary>
                    {judgeRationale}
                  </details>
                ) : (
                  '—'
                )}
              </TableCell>
            </TableRow>
          ),
        )}
      </TableBody>
    </Table>
  );
}
