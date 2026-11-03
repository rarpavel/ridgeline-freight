import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { formatPromptVersion, loadPrompt } from '@/server/prompts/load';
import { renderPrompt } from '@/server/prompts/render';

vi.mock('server-only', () => ({}));

describe('loadPrompt', () => {
  it('returns name, version, text and the first 8 hex chars of the file sha256', () => {
    const file = readFileSync('prompts/rag-system.v1.md');
    const prompt = loadPrompt('rag-system', 1);

    expect(prompt.name).toBe('rag-system');
    expect(prompt.version).toBe(1);
    expect(prompt.text).toBe(file.toString('utf8'));
    expect(prompt.hash).toBe(createHash('sha256').update(file).digest('hex').slice(0, 8));
  });

  it('gives the same hash on every load', () => {
    expect(loadPrompt('rag-system', 1).hash).toBe(loadPrompt('rag-system', 1).hash);
  });

  it('throws when the version file does not exist', () => {
    expect(() => loadPrompt('rag-system', 999)).toThrow('rag-system.v999.md');
  });

  it('formats the version recorded in traces', () => {
    const prompt = { name: 'rag-system', version: 1, hash: '1a2b3c4d', text: '' };
    expect(formatPromptVersion(prompt)).toBe('rag-system@v1#1a2b3c4d');
  });

  it('keeps prompts/rag-system.v3.md equal to the block in data-gen prompt 05', () => {
    const source = readFileSync('data-gen/prompts/05-rag-system-prompt.md', 'utf8');
    const block = /## Prompt \(system\)\n\n```\n([\s\S]*?)```/.exec(source)?.[1];

    expect(block).toBeDefined();
    expect(loadPrompt('rag-system', 3).text).toBe(block);
  });

  it('keeps prompts/judge.v1.md equal to the block in data-gen prompt 06', () => {
    const source = readFileSync('data-gen/prompts/06-judge.md', 'utf8');
    const block = /## Prompt\n\n```\n([\s\S]*?)```/.exec(source)?.[1];

    expect(block).toBeDefined();
    expect(loadPrompt('judge', 1).text).toBe(block);
  });
});

describe('renderPrompt', () => {
  it('replaces every occurrence of a variable', () => {
    expect(renderPrompt('{{a}} and {{b}} and {{a}}', { a: '1', b: '2' })).toBe('1 and 2 and 1');
  });

  it('throws with the variable name when a value is missing', () => {
    expect(() => renderPrompt('Hello {{missing}}', {})).toThrow('missing');
  });

  it('inserts values literally, without $ patterns or a second pass', () => {
    expect(renderPrompt('{{a}}', { a: '$& {{b}}' })).toBe('$& {{b}}');
  });

  it('ignores variables the template does not use', () => {
    expect(renderPrompt('plain', { unused: 'x' })).toBe('plain');
  });
});
