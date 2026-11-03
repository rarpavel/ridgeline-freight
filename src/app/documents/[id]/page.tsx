import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { DocumentText } from '@/components/viewer/DocumentText';
import { ScrollToCited } from '@/components/viewer/ScrollToCited';
import { sectionAt, type ViewerDocument } from '@/lib/document-blocks';
import { AppError } from '@/lib/errors';
import { requireSession } from '@/server/auth/require';
import { db } from '@/server/db/client';
import { findViewerDocument } from '@/server/db/queries/documents';

function BackToChat() {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href="/chat">Back to chat</Link>
    </Button>
  );
}

function NoAccess({ message }: { message: string }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-start justify-center gap-4 px-4">
      <h1 className="text-base font-semibold">No access</h1>
      <p className="text-muted-foreground text-sm">{message}</p>
      <BackToChat />
    </main>
  );
}

function citedSectionLabel({ sections, chunk }: ViewerDocument): string | null {
  const section = chunk && sectionAt(sections, chunk.charStart);
  if (!section) return null;
  return section.ref ? `§${section.ref} ${section.title}` : section.title;
}

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { role } = await requireSession();
  const { id } = await params;
  const { chunk } = await searchParams;
  const chunkId = typeof chunk === 'string' ? chunk : null;

  let document: ViewerDocument | null = null;
  try {
    document = await findViewerDocument({ id, chunkId, roles: [role] }, { db });
  } catch (err) {
    if (err instanceof AppError && err.code === 'forbidden') {
      return <NoAccess message={err.safeMessage} />;
    }
    if (!(err instanceof AppError && err.code === 'not_found')) throw err;
  }
  if (!document) notFound();

  const citedSection = citedSectionLabel(document);

  return (
    <div className="flex min-h-dvh flex-1 flex-col">
      <header className="border-border bg-background sticky top-0 z-10 flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <BackToChat />
          <Button asChild variant="outline" size="sm">
            {/* A plain link: the route answers with a file, not a page for the router. */}
            <a href={`/api/documents/${encodeURIComponent(document.id)}/original`}>
              Download original
            </a>
          </Button>
        </div>
        <h1 className="truncate text-base font-semibold">{document.title}</h1>
        {citedSection && (
          <p className="text-muted-foreground truncate text-xs" data-testid="cited-section">
            Cited section: {citedSection}
          </p>
        )}
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <DocumentText text={document.text} chunk={document.chunk} />
        {document.chunk && <ScrollToCited />}
      </main>
    </div>
  );
}
