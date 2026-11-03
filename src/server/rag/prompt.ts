import 'server-only';

import type { Role } from '@/server/auth/session';
import { formatPromptVersion, loadPrompt } from '@/server/prompts/load';
import { renderPrompt } from '@/server/prompts/render';

const MAX_QUESTION_CHARS = 500;
const CONTEXT_HEADING = 'CONTEXT PASSAGES (the only information you may use):';

const ragSystemPrompt = loadPrompt('rag-system', 3);

export const RAG_SYSTEM_PROMPT_VERSION = formatPromptVersion(ragSystemPrompt);

export type PromptChunk = {
  documentTitle: string;
  sectionRef: string | null;
  sectionTitle: string | null;
  contextPrefix: string;
  content: string;
};

export type PromptMessages = [
  { role: 'system'; content: string },
  { role: 'user'; content: string },
];

const TODAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: '2-digit',
  day: '2-digit',
  year: 'numeric',
});

function formatHeader(alias: number, { documentTitle, sectionRef, sectionTitle }: PromptChunk) {
  const section = [sectionRef, sectionTitle].filter(Boolean).join(' ');
  const source = section ? `${documentTitle} · Section ${section}` : documentTitle;
  return `[${alias}] Document: ${source}`;
}

// Only a later part of a split table has lines after the first in its prefix: the header rows,
// which the chunker keeps out of `content` so offsets hold (ADR-0017).
export function formatBody({
  contextPrefix,
  content,
}: Pick<PromptChunk, 'contextPrefix' | 'content'>) {
  const newline = contextPrefix.indexOf('\n');
  return newline === -1 ? content : `${contextPrefix.slice(newline + 1)}\n${content}`;
}

/** Single turn, no history (RAG_PIPELINE.md §2.4). Passage numbers are the citation aliases. */
export function buildMessages({
  role,
  today,
  chunks,
  question,
}: {
  role: Role;
  today: Date;
  chunks: readonly PromptChunk[];
  question: string;
}): PromptMessages {
  const blocks = chunks.map(
    (chunk, index) => `${formatHeader(index + 1, chunk)}\n<<<\n${formatBody(chunk)}\n>>>`,
  );
  return [
    {
      role: 'system',
      content: renderPrompt(ragSystemPrompt.text, { role, today: TODAY_FORMAT.format(today) }),
    },
    {
      role: 'user',
      content: [
        CONTEXT_HEADING,
        ...blocks,
        '',
        `QUESTION: ${question.slice(0, MAX_QUESTION_CHARS)}`,
      ].join('\n'),
    },
  ];
}
