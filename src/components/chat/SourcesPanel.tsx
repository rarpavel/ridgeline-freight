'use client';

import { useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  formatCost,
  formatMs,
  formatScore,
  formatTokens,
  splitCandidates,
  type TraceDetails,
} from '@/lib/trace-details';
import type { TraceCandidate } from '@/server/db/schema/request-traces';

const NOT_RECORDED = 'No trace was recorded for this answer.';
const LOAD_FAILED = 'Could not load the sources. Try again.';

type PanelState =
  | { status: 'idle' | 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'loaded'; trace: TraceDetails };

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}

function CandidateList({ candidates }: { candidates: TraceCandidate[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {candidates.map((candidate) => (
        <li
          key={candidate.chunkId}
          className="border-border flex flex-col gap-1 rounded-md border p-2"
          data-testid="source-candidate"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 font-medium break-words">
              {candidate.slug}
              {candidate.sectionRef && ` · §${candidate.sectionRef}`}
            </span>
            {candidate.cited && <Badge variant="secondary">cited ✓</Badge>}
          </div>
          <p className="text-muted-foreground font-mono text-xs">
            vector {formatScore(candidate.vectorSim)} · FTS {formatScore(candidate.ftsScore)} · RRF{' '}
            {formatScore(candidate.rrf)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function TraceView({ trace }: { trace: TraceDetails }) {
  const { retrieval } = trace;
  const { inPrompt, notInPrompt } = splitCandidates(retrieval.candidates);
  const isGateRefusal = trace.gate === 'refuse_gate';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Badge variant={isGateRefusal ? 'destructive' : 'secondary'}>
          gate: {isGateRefusal ? 'refused' : 'passed'}
        </Badge>
        {trace.refusalReason && <Badge variant="outline">refusal: {trace.refusalReason}</Badge>}
        {retrieval.vectorUnavailable && <Badge variant="outline">vector search unavailable</Badge>}
        {trace.error && <Badge variant="outline">error: {trace.error}</Badge>}
      </div>

      <dl className="grid grid-cols-2 gap-3">
        <Fact label="Best sim" value={formatScore(retrieval.bestSim)} />
        <Fact label="Sim floor" value={formatScore(retrieval.simFloor)} />
        <Fact label="FTS matches" value={String(retrieval.ftsMatches)} />
        <Fact
          label="Citations"
          value={`${trace.citationsValid} valid / ${trace.citationsDropped} dropped`}
        />
        <Fact label="Model" value={trace.model ?? '—'} />
        <Fact label="Prompt" value={trace.promptVersion ?? '—'} />
        <Fact label="Tokens" value={formatTokens(trace.inputTokens, trace.outputTokens)} />
        <Fact label="Cost" value={formatCost(trace.costUsd)} />
        <Fact label="TTFT" value={formatMs(trace.ttftMs)} />
        <Fact label="Latency" value={formatMs(trace.latencyMs)} />
      </dl>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">In prompt ({inPrompt.length})</h3>
        {inPrompt.length > 0 ? (
          <CandidateList candidates={inPrompt} />
        ) : (
          <p className="text-muted-foreground">No passages were sent to the model.</p>
        )}
      </section>

      {notInPrompt.length > 0 && (
        <details className="flex flex-col gap-2">
          <summary className="cursor-pointer font-medium">
            Not in prompt ({notInPrompt.length})
          </summary>
          <div className="mt-2">
            <CandidateList candidates={notInPrompt} />
          </div>
        </details>
      )}
    </div>
  );
}

/** Mount with `key={traceId}`: the state belongs to one answer. */
export function SourcesPanel({ traceId }: { traceId: string }) {
  const [state, setState] = useState<PanelState>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function load() {
    const abort = new AbortController();
    abortRef.current = abort;
    setState({ status: 'loading' });
    try {
      const response = await fetch(`/api/traces/${encodeURIComponent(traceId)}`, {
        signal: abort.signal,
      });
      if (response.status === 401) {
        window.location.assign('/login?next=/chat');
        return;
      }
      if (!response.ok) {
        const message = response.status === 404 ? NOT_RECORDED : LOAD_FAILED;
        setState({ status: 'failed', message });
        return;
      }
      setState({ status: 'loaded', trace: (await response.json()) as TraceDetails });
    } catch {
      if (!abort.signal.aborted) setState({ status: 'failed', message: LOAD_FAILED });
    }
  }

  function handleOpenChange(isOpen: boolean) {
    if (isOpen && state.status === 'idle') void load();
  }

  return (
    <Sheet onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="self-start">
          Show sources
        </Button>
      </SheetTrigger>
      {/* Full width on a phone: the score lines do not fit the sheet's default 3/4. */}
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader className="pr-12">
          <SheetTitle>Sources</SheetTitle>
          <SheetDescription>What was retrieved for this answer and what it cost.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          {state.status === 'loading' && (
            <div className="flex flex-col gap-2" data-testid="sources-loading">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
          {state.status === 'failed' && (
            <div className="flex flex-col items-start gap-2">
              <p className="text-muted-foreground">{state.message}</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          )}
          {state.status === 'loaded' && <TraceView trace={state.trace} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
