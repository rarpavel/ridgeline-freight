import Link from 'next/link';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { parseMarkdown, type Inline } from '@/lib/markdown';
import type { ChatCitation } from '@/lib/sse';

const CITATION_MARKER = /(\[\d{1,2}\])/;

function CitationChip({ citation }: { citation: ChatCitation }) {
  const { n, documentId, chunkId, title, sectionRef } = citation;
  const section = sectionRef ? ` · §${sectionRef}` : '';
  const query = new URLSearchParams({ chunk: chunkId });

  // `inline` instead of the badge's nowrap box: a long title wraps with the text on a phone.
  return (
    <Badge
      asChild
      variant="secondary"
      className="inline h-auto overflow-visible rounded-md align-baseline break-words whitespace-normal [box-decoration-break:clone]"
    >
      {/* The viewer arrives with RAG-029; until then there is nothing to prefetch. */}
      <Link href={`/documents/${encodeURIComponent(documentId)}?${query}`} prefetch={false}>
        [{n}] {title}
        {section}
      </Link>
    </Badge>
  );
}

function withChips(text: string, citations: ChatCitation[] | null): ReactNode[] {
  return text.split(CITATION_MARKER).map((part, index) => {
    const citation = citations?.find(({ n }) => `[${n}]` === part);
    return citation ? <CitationChip key={index} citation={citation} /> : part;
  });
}

function InlineContent({
  content,
  citations,
}: {
  content: Inline[];
  citations: ChatCitation[] | null;
}) {
  return content.map((inline, index) => {
    switch (inline.type) {
      case 'text':
        return <span key={index}>{withChips(inline.text, citations)}</span>;
      case 'bold':
        return (
          <strong key={index} className="font-semibold">
            {withChips(inline.text, citations)}
          </strong>
        );
      case 'code':
        return (
          <code key={index} className="bg-muted rounded px-1 font-mono text-[0.9em]">
            {inline.text}
          </code>
        );
    }
  });
}

/** Renders through `parseMarkdown` as React text only: nothing in an answer can become markup. */
export function AnswerText({
  text,
  citations,
}: {
  text: string;
  citations: ChatCitation[] | null;
}) {
  return (
    <div className="flex flex-col gap-3 break-words">
      {parseMarkdown(text).map((block, index) => {
        if (block.type === 'paragraph') {
          return (
            <p key={index} className="leading-7 whitespace-pre-wrap">
              <InlineContent content={block.content} citations={citations} />
            </p>
          );
        }
        const List = block.ordered ? 'ol' : 'ul';
        return (
          <List
            key={index}
            className={`flex flex-col gap-1 pl-5 leading-7 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
          >
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>
                <InlineContent content={item} citations={citations} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
