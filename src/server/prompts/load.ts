import 'server-only';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HASH_LENGTH = 8;

export type Prompt = {
  name: string;
  version: number;
  hash: string;
  text: string;
};

export function loadPrompt(name: string, version: number): Prompt {
  const file = readFileSync(path.join(process.cwd(), 'prompts', `${name}.v${version}.md`));
  const hash = createHash('sha256').update(file).digest('hex').slice(0, HASH_LENGTH);
  return { name, version, hash, text: file.toString('utf8') };
}

export function formatPromptVersion(prompt: Prompt): string {
  return `${prompt.name}@v${prompt.version}#${prompt.hash}`;
}
