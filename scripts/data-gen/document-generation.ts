import type { CatalogEntry } from '../../data-gen/schemas/catalog';
import type { Fact } from '../../data-gen/schemas/registry';
import type { World } from '../../data-gen/schemas/world';

const MAX_RETRIES = 2;

export function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function parsePromptTemplate(promptFile: string): string {
  const match = /## Prompt\n[\s\S]*?```\n([\s\S]*?)\n```/.exec(promptFile);
  if (!match?.[1]) throw new Error('Prompt block not found in the document prompt file');
  return match[1];
}

export function parseTypeGuidance(promptFile: string, docType: string): string {
  const match = new RegExp(`^- \\*\\*${docType}\\*\\*: (.+)$`, 'm').exec(promptFile);
  if (!match?.[1]) throw new Error(`Type guidance not found for ${docType}`);
  return match[1];
}

export function effectiveDateOf(slug: string, facts: Fact[]): string {
  const dates = facts.filter((fact) => fact.category === 'date');
  if (dates.length !== 1 || !dates[0]) {
    throw new Error(`${slug}: expected one date fact, found ${dates.length}`);
  }
  return dates[0].value;
}

// The catalog slug gives the document's own customer or carrier, since its facts may not reference it.
function ownEntityIds(slug: string): string[] {
  return [slug.replace(/^msa-/, 'cust-'), slug.replace(/^carrier-/, 'car-')];
}

export function buildWorldSlice(entry: CatalogEntry, facts: Fact[], world: World): object {
  const ids = new Set([...ownEntityIds(entry.slug), ...facts.flatMap((fact) => fact.entityIds ?? [])]);
  const referenced = <T extends { id: string }>(entities: T[]): T[] =>
    entities.filter(({ id }) => ids.has(id));
  return {
    company: world.company,
    customers: referenced(world.customers),
    carriers: referenced(world.carriers),
    lanes: referenced(world.lanes),
    warehouses: referenced(world.warehouses),
  };
}

export type GenerationResult<Report> = { markdown: string; report: Report; attempts: number };

// Calls the model until the check passes, feeding the errors of the last attempt back into the prompt.
export async function generateChecked<Report extends { errors: string[] }>(
  prompt: string,
  complete: (prompt: string) => Promise<string>,
  check: (markdown: string) => Report,
): Promise<GenerationResult<Report>> {
  let attempts = 0;
  let currentPrompt = prompt;
  for (;;) {
    attempts += 1;
    const markdown = (await complete(currentPrompt)).trim();
    const report = check(markdown);
    if (report.errors.length === 0 || attempts > MAX_RETRIES) return { markdown, report, attempts };
    const reasons = report.errors.map((error) => `- ${error}`).join('\n');
    currentPrompt = `${prompt}\n\nA previous attempt was rejected for these reasons:\n${reasons}\nWrite the complete document again and fix all of them.`;
  }
}
