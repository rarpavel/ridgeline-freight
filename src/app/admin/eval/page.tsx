import type { Metadata } from 'next';
import Link from 'next/link';

import { EvalRunsTable } from '@/components/eval/EvalRunsTable';
import { Button } from '@/components/ui/button';
import { requireRole } from '@/server/auth/require';
import { db } from '@/server/db/client';
import { listEvalRuns } from '@/server/db/queries/eval';

export const metadata: Metadata = { title: 'Evaluation runs' };

export default async function AdminEvalPage() {
  await requireRole('admin');
  const runs = await listEvalRuns({ db });

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-base font-semibold">Evaluation runs</h1>
        <Button asChild variant="outline" size="sm">
          <Link href="/chat">Back to chat</Link>
        </Button>
      </div>
      {runs.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No runs yet. Start one with <code>pnpm eval</code>.
        </p>
      ) : (
        <EvalRunsTable runs={runs} />
      )}
    </main>
  );
}
