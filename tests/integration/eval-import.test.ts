import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { evalQuestionsSchema, type EvalQuestion } from '../../data-gen/schemas/questions';
import { createDatabase, dropDatabase } from './helpers/database';

const run = promisify(execFile);

const DB_NAME = `ridgeline_eval_import_${process.pid}`;
const REPO = process.cwd();
const QUESTIONS = evalQuestionsSchema.parse(
  JSON.parse(readFileSync('data/eval/questions.json', 'utf8')),
);
const VERSION = readFileSync('data/VERSION', 'utf8').trim();

describe('pnpm eval:import', () => {
  let url: string;
  let client: Client;
  let fixtureDir: string;

  // The script reads data/ from its working directory, so a run from a temp directory imports a
  // changed file through the real CLI and leaves the repository's data alone.
  function importFrom(cwd: string) {
    return run(
      path.join(REPO, 'node_modules/.bin/tsx'),
      [
        '--conditions=react-server',
        `--tsconfig=${path.join(REPO, 'tsconfig.json')}`,
        path.join(REPO, 'scripts/eval-import.ts'),
      ],
      {
        cwd,
        env: {
          ...process.env,
          DATABASE_URL: url,
          OPENAI_API_KEY: 'unused-by-import',
          SESSION_SECRET: 'test-session-secret-at-least-32-chars',
          DEMO_ACCOUNTS_JSON: JSON.stringify([
            { id: 'sales', role: 'sales', passwordHash: `$2b$10$${'a'.repeat(53)}` },
          ]),
        },
      },
    );
  }

  async function importQuestions(questions: unknown[]) {
    await writeFile(path.join(fixtureDir, 'data/eval/questions.json'), JSON.stringify(questions));
    return importFrom(fixtureDir);
  }

  async function countRows(): Promise<number> {
    const { rows } = await client.query<{ count: string }>('SELECT count(*) FROM eval_questions');
    return Number(rows[0]?.count);
  }

  function changeFirst(changes: Record<string, unknown>): unknown[] {
    const [first, ...rest] = QUESTIONS as [EvalQuestion, ...EvalQuestion[]];
    return [{ ...first, ...changes }, ...rest];
  }

  beforeAll(async () => {
    await dropDatabase(DB_NAME);
    url = await createDatabase(DB_NAME);
    await run('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_URL_DIRECT: url } });
    client = new Client({ connectionString: url });
    await client.connect();

    fixtureDir = await mkdtemp(path.join(tmpdir(), 'ridgeline-eval-import-'));
    await mkdir(path.join(fixtureDir, 'data/eval'), { recursive: true });
    await writeFile(path.join(fixtureDir, 'data/VERSION'), `${VERSION}\n`);
  });

  beforeEach(async () => {
    await client.query('TRUNCATE eval_questions CASCADE');
  });

  afterAll(async () => {
    await client?.end();
    await dropDatabase(DB_NAME);
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('imports the 44 reviewed questions with their split and the version from data/VERSION', async () => {
    await importFrom(REPO);

    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT slug, category, split, role, question, expected_answer, expected_doc_slugs,
              source_fact_ids, distractor_doc_slugs, reviewed, notes, dataset_version
       FROM eval_questions`,
    );
    expect(rows).toHaveLength(44);
    expect(rows.filter((row) => row.split === 'dev')).toHaveLength(16);
    expect(rows.filter((row) => row.split === 'test')).toHaveLength(28);

    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    for (const question of QUESTIONS) {
      expect(bySlug.get(question.slug)).toEqual({
        slug: question.slug,
        category: question.category,
        split: question.split,
        role: question.role,
        question: question.question,
        expected_answer: question.expectedAnswer,
        expected_doc_slugs: question.expectedDocSlugs,
        source_fact_ids: question.sourceFactIds,
        distractor_doc_slugs: question.distractorDocSlugs,
        reviewed: true,
        notes: question.notes,
        dataset_version: VERSION,
      });
    }
  });

  it('updates a changed question in place on a second import, adding no rows', async () => {
    await importFrom(REPO);
    const slug = QUESTIONS[0]?.slug;
    const before = await client.query('SELECT id FROM eval_questions WHERE slug = $1', [slug]);

    const question = 'What does this reworded question ask about Harbor Point Foods?';
    await importQuestions(changeFirst({ question }));

    expect(await countRows()).toBe(44);
    const after = await client.query('SELECT id, question FROM eval_questions WHERE slug = $1', [
      slug,
    ]);
    expect(after.rows).toEqual([{ id: before.rows[0]?.id, question }]);
  });

  it('skips a question with reviewed false and warns about it', async () => {
    const { stderr } = await importQuestions(changeFirst({ reviewed: false }));

    expect(await countRows()).toBe(43);
    expect(stderr).toContain(`${QUESTIONS[0]?.slug}: skipped, reviewed is false`);
  });

  it('exits non-zero and writes nothing when a category is outside the list', async () => {
    await expect(importQuestions(changeFirst({ category: 'trivia' }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('category'),
    });

    expect(await countRows()).toBe(0);
  });
});
