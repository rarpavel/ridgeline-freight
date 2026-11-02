import 'server-only';

import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

import type { ParsedDocx } from '@/server/ingest/parsers/docx';

export const CHUNKER_VERSION = 'v1';
export const MIN_CHUNK_TOKENS = 120;
export const MAX_CHUNK_TOKENS = 600;
export const OVERLAP_TOKENS = 50;
// Tables stay whole past MAX_CHUNK_TOKENS; only a table above TABLE_SPLIT_TOKENS is split by rows.
// The difference leaves room for a short heading or note to merge into any table or table part.
export const MAX_TABLE_TOKENS = 1200;
const TABLE_SPLIT_TOKENS = MAX_TABLE_TOKENS - MIN_CHUNK_TOKENS;

export type Chunk = {
  sectionRef: string | null;
  sectionTitle: string | null;
  contextPrefix: string;
  content: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
};

type Range = { start: number; end: number };

type Draft = Range & {
  sectionRef: string | null;
  h2: string;
  h3: string;
  // Index of the enclosing "##" section; the first merge pass stays inside it.
  group: number;
  isTable: boolean;
  hasBody: boolean;
  // Header rows of a split table, for every part after the first (ADR-0017).
  tableHeader?: string;
};

const CLAUSE = /^(\d+(?:\.\d+)+)\.?\s/;
const TABLE_LINE = '| ';

const encoding = new Tiktoken(o200kBase);

// Empty special-token lists make text such as "<|endoftext|>" count as text instead of throwing.
function countTokens(text: string): number {
  return encoding.encode(text, [], []).length;
}

function lineRanges({ start, end }: Range, text: string): Range[] {
  const ranges: Range[] = [];
  let offset = start;
  for (const line of text.slice(start, end).split('\n')) {
    ranges.push({ start: offset, end: offset + line.length });
    offset += line.length + 1;
  }
  return ranges;
}

function buildUnits({ text, sections }: ParsedDocx): Draft[] {
  const sectionAt = new Map(sections.map((section) => [section.charStart, section]));
  const units: Draft[] = [];
  let sectionRef: string | null = null;
  let h2 = '';
  let h3 = '';
  let group = 0;
  let current: Draft | undefined;

  const open = (start: number, isTable = false) => {
    current = { start, end: start, sectionRef, h2, h3, group, isTable, hasBody: false };
    units.push(current);
    return current;
  };

  for (const { start, end } of lineRanges({ start: 0, end: text.length }, text)) {
    const line = text.slice(start, end);
    const section = sectionAt.get(start);
    let unit: Draft | undefined = current;

    if (section) {
      const level = /^#+/.exec(line)?.[0].length ?? 1;
      if (level === 1) [h2, h3] = ['', ''];
      if (level === 2) {
        [h2, h3] = [section.title, ''];
        group += 1;
      }
      if (level === 3) h3 = section.title;
      sectionRef = section.ref || null;
      unit = open(start);
    } else if (line.startsWith(TABLE_LINE)) {
      unit = unit?.isTable ? unit : open(start, true);
      unit.hasBody = true;
    } else {
      const clauseRef = CLAUSE.exec(line)?.[1];
      if (clauseRef) sectionRef = clauseRef;
      // A clause right after its heading stays with that heading.
      if (!unit || unit.isTable || (clauseRef && unit.hasBody)) unit = open(start);
      if (clauseRef) unit.sectionRef = clauseRef;
      unit.hasBody = true;
    }
    unit.end = end;
  }
  return units;
}

// A paragraph too long for one chunk is the only place that cuts inside a line. Leaving room for
// the overlap means a piece always fits in a chunk together with the overlap before it.
function wrapLine(line: Range, text: string): Range[] {
  const limit = MAX_CHUNK_TOKENS - OVERLAP_TOKENS;
  if (countTokens(text.slice(line.start, line.end)) <= limit) return [line];
  const pieces: Range[] = [];
  let piece: Range | undefined;
  for (const word of text.slice(line.start, line.end).matchAll(/\S+/g)) {
    const start = line.start + word.index;
    const end = start + word[0].length;
    if (piece && countTokens(text.slice(piece.start, end)) <= limit) piece.end = end;
    else {
      piece = { start, end };
      pieces.push(piece);
    }
  }
  return pieces;
}

function overlapStart({ start, end }: Range, text: string): number {
  const words = [...text.slice(start, end).matchAll(/\S+/g)].reverse();
  let overlap = end;
  for (const word of words) {
    const wordStart = start + word.index;
    if (countTokens(text.slice(wordStart, end)) > OVERLAP_TOKENS) break;
    overlap = wordStart;
  }
  return overlap;
}

function splitLongUnit(unit: Draft, text: string): Draft[] {
  const [first, ...rest] = lineRanges(unit, text).flatMap((line) => wrapLine(line, text));
  if (!first) return [unit];
  const parts: Range[] = [{ ...first }];
  for (const piece of rest) {
    const part = parts.at(-1) ?? first;
    if (countTokens(text.slice(part.start, piece.end)) <= MAX_CHUNK_TOKENS) part.end = piece.end;
    else parts.push({ start: overlapStart(part, text), end: piece.end });
  }
  return parts.map((part) => ({ ...unit, ...part, hasBody: true }));
}

function splitLongTable(unit: Draft, text: string): Draft[] {
  const [header, separator, ...rows] = lineRanges(unit, text);
  if (!header || !separator || rows.length === 0) return [unit];
  const tableHeader = text.slice(header.start, separator.end);
  const parts: Draft[] = [];
  let part: Draft = { ...unit, end: separator.end };
  for (const row of rows) {
    const candidate = text.slice(part.start, row.end);
    const hasRow = part.end > separator.end;
    const prefix = part.tableHeader ? `${part.tableHeader}\n` : '';
    if (hasRow && countTokens(prefix + candidate) > TABLE_SPLIT_TOKENS) {
      parts.push(part);
      part = { ...unit, start: row.start, end: row.end, tableHeader };
    } else part.end = row.end;
  }
  parts.push(part);
  return parts;
}

function splitUnit(unit: Draft, text: string): Draft[] {
  const tokens = countTokens(text.slice(unit.start, unit.end));
  if (unit.isTable) return tokens > TABLE_SPLIT_TOKENS ? splitLongTable(unit, text) : [unit];
  return tokens > MAX_CHUNK_TOKENS ? splitLongUnit(unit, text) : [unit];
}

// The merged chunk is cited by the first part that has text, not by a bare heading above it.
function merge(first: Draft, second: Draft): Draft {
  const { sectionRef, h2, h3 } = first.hasBody ? first : second;
  return {
    ...first,
    sectionRef,
    h2,
    h3,
    end: second.end,
    isTable: first.isTable || second.isTable,
    hasBody: first.hasBody || second.hasBody,
  };
}

function isUndersized(draft: Draft, text: string): boolean {
  return !draft.isTable && countTokens(text.slice(draft.start, draft.end)) < MIN_CHUNK_TOKENS;
}

function fits(first: Draft, second: Draft, text: string): boolean {
  const limit = first.isTable || second.isTable ? MAX_TABLE_TOKENS : MAX_CHUNK_TOKENS;
  return countTokens(text.slice(first.start, second.end)) <= limit;
}

function mergeWithinSections(drafts: Draft[], text: string): Draft[] {
  const merged: Draft[] = [];
  for (const draft of drafts) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.group === draft.group &&
      isUndersized(previous, text) &&
      fits(previous, draft, text)
    ) {
      merged[merged.length - 1] = merge(previous, draft);
    } else merged.push(draft);
  }
  return merged;
}

// Most sections of the corpus are below the minimum on their own, so what the first pass leaves
// small moves into a neighbour: forward first, and into a table only when no text chunk fits.
function mergeAcrossSections(drafts: Draft[], text: string): Draft[] {
  const merged = [...drafts];
  let index = 0;
  while (index < merged.length) {
    const draft = merged[index];
    if (!draft || !isUndersized(draft, text)) {
      index += 1;
      continue;
    }
    const firstIndex = [index + 1, index - 1]
      .sort((a, b) => Number(merged[a]?.isTable) - Number(merged[b]?.isTable))
      .map((neighbour) => Math.min(index, neighbour))
      .find((candidate) => {
        const [first, second] = [merged[candidate], merged[candidate + 1]];
        return first && second && fits(first, second, text);
      });
    const [first, second] =
      firstIndex === undefined ? [] : [merged[firstIndex], merged[firstIndex + 1]];
    if (firstIndex === undefined || !first || !second) {
      index += 1;
      continue;
    }
    merged.splice(firstIndex, 2, merge(first, second));
    index = firstIndex;
  }
  return merged;
}

function toChunk(draft: Draft, text: string, title: string): Chunk {
  const content = text.slice(draft.start, draft.end);
  const path = [draft.h2, draft.h3].filter(Boolean).join(' › ');
  const prefix = path ? `${title} — ${path}` : title;
  return {
    sectionRef: draft.sectionRef,
    sectionTitle: draft.h3 || draft.h2 || null,
    contextPrefix: draft.tableHeader ? `${prefix}\n${draft.tableHeader}` : prefix,
    content,
    charStart: draft.start,
    charEnd: draft.end,
    tokenCount: countTokens(content),
  };
}

export function chunkDocument(parsed: ParsedDocx, title: string): Chunk[] {
  const { text } = parsed;
  if (text === '') return [];
  const units = buildUnits(parsed).flatMap((unit) => splitUnit(unit, text));
  return mergeAcrossSections(mergeWithinSections(units, text), text).map((draft) =>
    toChunk(draft, text, title),
  );
}
