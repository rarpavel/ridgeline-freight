import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { catalogSchema } from '../../data-gen/schemas/catalog';
import { worldSchema } from '../../data-gen/schemas/world';
import { describeError } from './describe-error';
import { readOption } from './document-generation';
import { renderDocx } from './markdown-docx';

const MARKDOWN_DIR = 'data/generated/md';
const CORPUS_DIR = 'data/corpus';
const FIXTURES_DIR = 'tests/fixtures';

type Job = { documentId: string; source: string; target: string };

function corpusJobs(only: string | undefined): Job[] {
  const catalog = catalogSchema.parse(JSON.parse(readFileSync('data/catalog.json', 'utf8')));
  const entries = catalog.filter((entry) => !only || entry.slug === only);
  if (entries.length === 0) throw new Error(`No document matches --only ${only}`);
  return entries.map(({ slug, type }) => ({
    documentId: slug,
    source: path.join(MARKDOWN_DIR, `${slug}.md`),
    target: path.join(CORPUS_DIR, type, `${slug}.docx`),
  }));
}

function fixtureJobs(): Job[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const base = name.slice(0, -'.md'.length);
      return {
        documentId: `fixture-${base}`,
        source: path.join(FIXTURES_DIR, name),
        target: path.join(FIXTURES_DIR, `${base}.docx`),
      };
    });
}

async function main(): Promise<void> {
  const world = worldSchema.parse(JSON.parse(readFileSync('data/world.json', 'utf8')));
  const jobs = process.argv.includes('--fixtures') ? fixtureJobs() : corpusJobs(readOption('--only'));

  const missing = jobs.filter(({ source }) => !existsSync(source));
  if (missing.length > 0) {
    throw new Error(`Missing Markdown: ${missing.map(({ source }) => source).join(', ')}`);
  }

  for (const { documentId, source, target } of jobs) {
    let docx: Buffer;
    try {
      docx = await renderDocx(readFileSync(source, 'utf8'), {
        companyName: world.company.name,
        documentId,
      });
    } catch (err) {
      throw new Error(`${source}: ${describeError(err)}`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, docx);
    const sha256 = createHash('sha256').update(docx).digest('hex');
    console.log(`ok ${target}: ${docx.length} bytes, sha256 ${sha256}`);
  }
  console.log(`rendered: ${jobs.length}`);
}

main().catch((err: unknown) => {
  console.error(describeError(err));
  process.exit(1);
});
