import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  chunkDocument,
  CHUNKER_VERSION,
  MAX_CHUNK_TOKENS,
  MAX_TABLE_TOKENS,
  MIN_CHUNK_TOKENS,
  OVERLAP_TOKENS,
  type Chunk,
} from '@/server/ingest/chunker';
import { parseDocx, type ParsedDocx } from '@/server/ingest/parsers/docx';

import { renderDocx } from '../../scripts/data-gen/markdown-docx';

vi.mock('server-only', () => ({}));

const OPTIONS = { companyName: 'Ridgeline Freight, LLC', documentId: 'doc-1' };
const TITLE = 'Test Document';
const SENTENCE =
  'The carrier shall deliver each shipment within the agreed window and notify the customer. ';
const CORPUS = 'data/corpus';

async function parseMarkdown(markdown: string): Promise<ParsedDocx> {
  return parseDocx(await renderDocx(markdown, OPTIONS));
}

function words(sentences: number): string {
  return SENTENCE.repeat(sentences).trim();
}

function hasTable(chunk: Chunk): boolean {
  return /^\| --- /m.test(chunk.content);
}

function tableRows(prefix: string, count: number): string {
  const rows = Array.from({ length: count }, (_, index) => `| ${prefix}-${index} | $${index}.00 |`);
  return ['| Lane | Rate |', '| --- | --- |', ...rows].join('\n');
}

function expectOffsetsMatch(text: string, chunks: Chunk[]) {
  for (const chunk of chunks) {
    expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
  }
}

// Consecutive chunks may overlap; anything left between them must be whitespace.
function expectFullCoverage(text: string, chunks: Chunk[]) {
  let covered = 0;
  for (const chunk of chunks) {
    expect(text.slice(covered, Math.max(covered, chunk.charStart)).trim()).toBe('');
    covered = Math.max(covered, chunk.charEnd);
  }
  expect(text.slice(covered).trim()).toBe('');
}

function expectSizes(chunks: Chunk[]) {
  for (const chunk of chunks) {
    if (hasTable(chunk)) continue;
    expect(chunk.tokenCount).toBeGreaterThanOrEqual(MIN_CHUNK_TOKENS);
    expect(chunk.tokenCount).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
  }
}

describe('chunkDocument', () => {
  it('keeps every chunk of the MSA fixture within the size limits and offsets', async () => {
    const parsed = await parseDocx(readFileSync('tests/fixtures/contract.docx'));
    const chunks = chunkDocument(parsed, 'Fixture Foods MSA');
    expect(chunks.length).toBeGreaterThan(0);
    expectSizes(chunks);
    expectOffsetsMatch(parsed.text, chunks);
    expectFullCoverage(parsed.text, chunks);
  });

  it('holds the size, offset, coverage and table rules on all 24 corpus documents', async () => {
    const files = readdirSync(CORPUS, { recursive: true, encoding: 'utf8' }).filter((file) =>
      file.endsWith('.docx'),
    );
    expect(files).toHaveLength(24);
    let total = 0;
    for (const file of files) {
      const parsed = await parseDocx(readFileSync(join(CORPUS, file)));
      const chunks = chunkDocument(parsed, file);
      total += chunks.length;
      expectSizes(chunks);
      expectOffsetsMatch(parsed.text, chunks);
      expectFullCoverage(parsed.text, chunks);
      const tables = parsed.text.match(/^\| --- /gm)?.length ?? 0;
      expect(chunks.filter(hasTable)).toHaveLength(tables);
      for (const chunk of chunks) {
        expect(chunk.content.match(/^\| --- /gm)?.length ?? 0).toBeLessThanOrEqual(1);
      }
    }
    expect(total).toBeGreaterThanOrEqual(400);
    expect(total).toBeLessThanOrEqual(900);
  });

  it('puts each of three tables in its own chunk and keeps a table above 600 tokens whole', async () => {
    const big = tableRows('BIG', 60);
    const parsed = await parseMarkdown(
      [
        '# Rates',
        `## 1. First\n\n${tableRows('A', 2)}`,
        `## 2. Second\n\n${words(10)}\n\n${tableRows('B', 2)}\n\n${words(10)}`,
        `## 3. Third\n\n${big}`,
      ].join('\n\n'),
    );
    const chunks = chunkDocument(parsed, TITLE).filter(hasTable);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.content).toContain('| A-1 |');
    expect(chunks[1]?.content).toContain('| B-1 |');
    expect(chunks[1]?.content).not.toContain(SENTENCE.trim());
    expect(chunks[2]?.tokenCount).toBeGreaterThan(MAX_CHUNK_TOKENS);
    expect(chunks[2]?.content).toContain(big);
    expectOffsetsMatch(parsed.text, chunks);
  });

  it('splits a table above the table limit by rows and repeats the header row in the prefix', async () => {
    const parsed = await parseMarkdown(`# Rates\n\n## 1. Lanes\n\n${tableRows('L', 220)}`);
    const chunks = chunkDocument(parsed, TITLE);
    expect(chunks.length).toBeGreaterThan(1);
    const header = '| Lane | Rate |\n| --- | --- |';
    expect(chunks[0]?.content).toContain(`## 1. Lanes\n${header}`);
    expect(chunks[0]?.contextPrefix).toBe(`${TITLE} — Lanes`);
    for (const chunk of chunks.slice(1)) {
      expect(chunk.contextPrefix).toBe(`${TITLE} — Lanes\n${header}`);
      expect(chunk.content.startsWith('| L-')).toBe(true);
    }
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(MAX_TABLE_TOKENS);
    }
    const rows = chunks.flatMap((chunk) => chunk.content.match(/^\| L-\d+ /gm) ?? []);
    expect(rows).toHaveLength(220);
    expect(new Set(rows).size).toBe(220);
    expectOffsetsMatch(parsed.text, chunks);
  });

  it('returns identical JSON on two runs and exports the chunker version', async () => {
    const parsed = await parseDocx(readFileSync('tests/fixtures/rate-sheet.docx'));
    expect(JSON.stringify(chunkDocument(parsed, TITLE))).toBe(
      JSON.stringify(chunkDocument(parsed, TITLE)),
    );
    expect(CHUNKER_VERSION).toBe('v2');
  });

  it('merges short sub-units with the following ones, also across sections', async () => {
    const parsed = await parseMarkdown(
      [
        '# Agreement',
        `## 1. Term\n\n### 1.1 Start\n\n${words(1)}\n\n### 1.2 End\n\n${words(1)}`,
        `## 2. Notice\n\n${words(1)}`,
        `## 3. Payment\n\n${words(12)}`,
      ].join('\n\n'),
    );
    const chunks = chunkDocument(parsed, TITLE);
    expectSizes(chunks);
    expectFullCoverage(parsed.text, chunks);
    expect(chunks[0]?.content).toContain('### 1.2 End');
    expect(chunks[0]?.sectionRef).toBe('1.1');
    expect(chunks[0]?.sectionTitle).toBe('Start');
  });

  it('merges a short last section into the previous chunk, even a table', async () => {
    const parsed = await parseMarkdown(
      `# Rates\n\n## Lanes\n\n${tableRows('L', 3)}\n\n## Notes\n\n1. Payment follows Net 15.`,
    );
    const chunks = chunkDocument(parsed, TITLE);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain('## Lanes');
    expect(chunks[0]?.content).toContain('Net 15');
    expect(chunks[0]?.sectionTitle).toBe('Lanes');
  });

  it('splits a long section at paragraph boundaries with an overlap of at most 50 tokens', async () => {
    const paragraphs = Array.from({ length: 12 }, () => words(10)).join('\n\n');
    const parsed = await parseMarkdown(`# Policy\n\n## 1. Duties\n\n${paragraphs}`);
    const chunks = chunkDocument(parsed, TITLE);
    expect(chunks.length).toBeGreaterThan(1);
    expectSizes(chunks);
    expectOffsetsMatch(parsed.text, chunks);
    expectFullCoverage(parsed.text, chunks);
    for (const [index, chunk] of chunks.slice(1).entries()) {
      const previous = chunks[index];
      expect(chunk.charStart).toBeLessThan(previous?.charEnd ?? 0);
      const overlap = parsed.text.slice(chunk.charStart, previous?.charEnd);
      expect(overlap.split(/\s+/).length).toBeLessThanOrEqual(OVERLAP_TOKENS);
      expect(previous?.content.at(-1)).toBe('.');
    }
  });

  it('cuts a paragraph too long for one chunk at word boundaries', async () => {
    const parsed = await parseMarkdown(`# Policy\n\n## 1. Duties\n\n${words(60)}`);
    const chunks = chunkDocument(parsed, TITLE);
    expect(chunks.length).toBeGreaterThan(1);
    expectSizes(chunks);
    expectOffsetsMatch(parsed.text, chunks);
    expectFullCoverage(parsed.text, chunks);
    for (const chunk of chunks) expect(chunk.content).toBe(chunk.content.trim());
  });

  it('builds the prefix from the parts that exist and takes the ref from a numbered clause', async () => {
    const parsed = await parseMarkdown(
      [
        `# Agreement\n\n${words(8)}`,
        `## 3. Scope\n\n${words(8)}`,
        `### 3.1 Lanes\n\n${words(8)}`,
        `## 4. Rates\n\n4.1 Base\n\n${words(8)}\n\n4.2 Fuel\n\n${words(8)}`,
      ].join('\n\n'),
    );
    const chunks = chunkDocument(parsed, TITLE);
    expect(
      chunks.map(({ sectionRef, sectionTitle, contextPrefix }) => [
        sectionRef,
        sectionTitle,
        contextPrefix,
      ]),
    ).toEqual([
      [null, null, TITLE],
      ['3', 'Scope', `${TITLE} — Scope`],
      ['3.1', 'Lanes', `${TITLE} — Scope › Lanes`],
      ['4.1', 'Rates', `${TITLE} — Rates`],
      ['4.2', 'Rates', `${TITLE} — Rates`],
    ]);
  });

  it('counts special-token text instead of throwing and returns nothing for empty text', () => {
    const text = `# Doc\nA line with <|endoftext|> inside.`;
    const parsed = {
      text,
      sections: [{ ref: '', title: 'Doc', charStart: 0, charEnd: text.length }],
    };
    expect(chunkDocument(parsed, TITLE)).toHaveLength(1);
    expect(chunkDocument({ text: '', sections: [] }, TITLE)).toEqual([]);
  });
});
