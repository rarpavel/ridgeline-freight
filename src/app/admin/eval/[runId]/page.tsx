import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CategoryMetricsTable } from '@/components/eval/CategoryMetricsTable';
import { EvalResultsTable } from '@/components/eval/EvalResultsTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/eval-format';
import { requireRole } from '@/server/auth/require';
import { db } from '@/server/db/client';
import { findEvalRun, listEvalResults } from '@/server/db/queries/eval';

import { QUESTION_CATEGORIES } from '../../../../../data-gen/schemas/questions';

export const metadata: Metadata = { title: 'Evaluation run' };

function CategoryFilter({ runId, selected }: { runId: string; selected: string | null }) {
  const options = [null, ...QUESTION_CATEGORIES];
  return (
    <nav aria-label="Filter by category" className="flex flex-wrap gap-2">
      {options.map((category) => (
        <Button
          key={category ?? 'all'}
          asChild
          size="sm"
          variant={category === selected ? 'default' : 'outline'}
        >
          <Link
            href={`/admin/eval/${runId}${category ? `?category=${category}` : ''}`}
            aria-current={category === selected ? 'page' : undefined}
          >
            {category ?? 'all'}
          </Link>
        </Button>
      ))}
    </nav>
  );
}

export default async function AdminEvalRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole('admin');
  const { runId } = await params;
  const { category } = await searchParams;

  const run = await findEvalRun(runId, { db });
  if (!run) notFound();
  const results = await listEvalResults(run.id, { db });

  // Anything else in the URL shows every row, like the page without a filter.
  const selected = QUESTION_CATEGORIES.find((known) => known === category) ?? null;
  const shown = selected ? results.filter((result) => result.category === selected) : results;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/eval">Back to runs</Link>
          </Button>
        </div>
        <h1 className="text-base font-semibold">
          {run.label ?? 'Unlabeled run'}
          {!run.finishedAt && (
            <Badge variant="outline" className="ml-2">
              Not finished
            </Badge>
          )}
        </h1>
        <p className="text-muted-foreground text-xs">
          {formatDate(run.startedAt)} · {run.split} · {run.model} · judge {run.judgeModel ?? 'none'}{' '}
          · {run.promptVersion} · dataset {run.datasetVersion} · commit {run.gitSha.slice(0, 7)}
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Metrics by category</h2>
        <CategoryMetricsTable metrics={run.metrics} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">
          Questions ({shown.length} of {results.length})
        </h2>
        <CategoryFilter runId={run.id} selected={selected} />
        <EvalResultsTable results={shown} />
      </section>
    </main>
  );
}
