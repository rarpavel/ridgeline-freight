import type { CatalogEntry } from '../../data-gen/schemas/catalog';
import type { Fact, Registry } from '../../data-gen/schemas/registry';
import type { World } from '../../data-gen/schemas/world';
import { findBlocklistHits, findForbiddenPatterns } from './text-checks';

const MIN_FACTS_PER_DOC = 5;
const MAX_FACTS_PER_DOC = 8;
const MIN_DIFFERS_FROM = 8;
const MIN_EXCEPTIONS = 4;
const UNIQUE_VALUE_CATEGORIES: Fact['category'][] = ['penalty', 'liability_cap'];

const MONEY = /^\$\d{1,3}(,\d{3})*\.\d{2}$/;
const DATE = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
// Finds names with a legal suffix. It cannot see an invented name without one, such as "Bluepeak Transport".
const LEGAL_NAME = /(?:[A-Z][\w&'-]*,? )+(?:LLC|Inc\.?|Corp\.?|Ltd\.?)/g;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export type RegistryDeps = { catalog: CatalogEntry[]; world: World; blocklist: string[] };

export type RegistryReport = {
  errors: string[];
  factCount: number;
  differsFromCount: number;
  exceptionCount: number;
};

function factText(fact: Fact): string {
  return [fact.statement, fact.value, ...fact.aliases].join('\n');
}

function checkCounts(registry: Registry, catalog: CatalogEntry[]): string[] {
  const errors: string[] = [];
  for (const { slug } of catalog) {
    const count = registry.facts.filter((fact) => fact.docSlug === slug).length;
    if (count < MIN_FACTS_PER_DOC || count > MAX_FACTS_PER_DOC) {
      errors.push(`${slug}: ${count} facts, expected ${MIN_FACTS_PER_DOC}-${MAX_FACTS_PER_DOC}`);
    }
  }
  return errors;
}

function checkIds(fact: Fact, slugs: Set<string>): string[] {
  const errors: string[] = [];
  if (!slugs.has(fact.docSlug)) errors.push(`${fact.factId}: ${fact.docSlug} is not in the catalog`);
  if (!fact.factId.startsWith(`${fact.docSlug}#`)) {
    errors.push(`${fact.factId}: id does not start with ${fact.docSlug}`);
  }
  return errors;
}

function checkMoney(fact: Fact): string[] {
  if (!MONEY.test(fact.value)) return [`${fact.factId}: ${fact.value} is not canonical money`];
  if (!fact.value.endsWith('.00')) return [];
  const short = fact.value.slice(0, -'.00'.length);
  return fact.aliases.includes(short) ? [] : [`${fact.factId}: aliases must include ${short}`];
}

function checkDate(fact: Fact): string[] {
  const match = DATE.exec(fact.value);
  if (!match) return [`${fact.factId}: ${fact.value} is not an MM/DD/YYYY date`];
  const [month, day] = fact.value.split('/').map(Number);
  const long = `${MONTHS[(month ?? 0) - 1]} ${day}, ${fact.value.slice(-4)}`;
  return fact.aliases.includes(long) ? [] : [`${fact.factId}: aliases must include ${long}`];
}

function checkValue(fact: Fact): string[] {
  const errors: string[] = [];
  if (ISO_DATE.test(factText(fact))) errors.push(`${fact.factId}: contains an ISO date`);
  if (fact.valueType === 'money') errors.push(...checkMoney(fact));
  if (fact.valueType === 'date' && !ISO_DATE.test(fact.value)) errors.push(...checkDate(fact));
  return errors;
}

function checkDiffersFrom(
  fact: Fact,
  factsById: Map<string, Fact>,
  typeBySlug: Map<string, string>,
): string[] {
  const errors: string[] = [];
  for (const targetId of fact.differsFrom ?? []) {
    const target = factsById.get(targetId);
    const prefix = `${fact.factId}: differsFrom ${targetId}`;
    if (!target) {
      errors.push(`${prefix} does not exist`);
      continue;
    }
    if (target.category !== fact.category) errors.push(`${prefix} has another category`);
    if (target.value === fact.value) errors.push(`${prefix} has the same value`);
    if (target.docSlug === fact.docSlug) {
      errors.push(`${prefix} must be in another document`);
    } else if (typeBySlug.get(target.docSlug) !== typeBySlug.get(fact.docSlug)) {
      errors.push(`${prefix} must be in a document of the same type`);
    }
  }
  return errors;
}

function checkUniqueValues(registry: Registry): string[] {
  const errors: string[] = [];
  for (const category of UNIQUE_VALUE_CATEGORIES) {
    const slugsByValue = new Map<string, Set<string>>();
    for (const fact of registry.facts.filter((candidate) => candidate.category === category)) {
      const slugs = slugsByValue.get(fact.value) ?? new Set<string>();
      slugsByValue.set(fact.value, slugs.add(fact.docSlug));
    }
    for (const [value, slugs] of slugsByValue) {
      if (slugs.size > 1) errors.push(`${category} ${value} repeats in ${[...slugs].join(', ')}`);
    }
  }
  return errors;
}

function checkDuplicateIds(registry: Registry): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const { factId } of registry.facts) {
    if (seen.has(factId)) errors.push(`${factId}: duplicate fact id`);
    seen.add(factId);
  }
  return errors;
}

function checkNames(fact: Fact, worldNames: string[]): string[] {
  const candidates = fact.statement.match(LEGAL_NAME) ?? [];
  return candidates
    .filter((candidate) => !worldNames.some((name) => candidate.includes(name)))
    .map((candidate) => `${fact.factId}: ${candidate} is not in the world bible`);
}

function checkEntities(fact: Fact, entityIds: Set<string>): string[] {
  return (fact.entityIds ?? [])
    .filter((id) => !entityIds.has(id))
    .map((id) => `${fact.factId}: unknown entity ${id}`);
}

function checkText(fact: Fact, blocklist: string[]): string[] {
  const text = factText(fact);
  const errors = findBlocklistHits(text, blocklist).map(
    (name) => `${fact.factId}: blocklist hit ${name}`,
  );
  const patterns = findForbiddenPatterns(text).map(
    (label) => `${fact.factId}: forbidden pattern ${label}`,
  );
  return [...errors, ...patterns];
}

export function validateRegistry(registry: Registry, deps: RegistryDeps): RegistryReport {
  const { catalog, world, blocklist } = deps;
  const slugs = new Set(catalog.map((entry) => entry.slug));
  const typeBySlug = new Map(catalog.map((entry) => [entry.slug, entry.type]));
  const factsById = new Map(registry.facts.map((fact) => [fact.factId, fact]));
  const entityIds = new Set(
    [...world.customers, ...world.carriers, ...world.lanes, ...world.warehouses].map(({ id }) => id),
  );
  const worldNames = [
    world.company.name,
    ...world.customers.map(({ name }) => name),
    ...world.carriers.map(({ name }) => name),
  ];

  const errors = [
    ...checkCounts(registry, catalog),
    ...checkDuplicateIds(registry),
    ...checkUniqueValues(registry),
    ...registry.facts.flatMap((fact) => [
      ...checkIds(fact, slugs),
      ...checkValue(fact),
      ...checkDiffersFrom(fact, factsById, typeBySlug),
      ...checkEntities(fact, entityIds),
      ...checkText(fact, blocklist),
      ...checkNames(fact, worldNames),
    ]),
  ];

  const differsFromCount = registry.facts.filter((fact) => fact.differsFrom?.length).length;
  const exceptionCount = registry.facts.filter((fact) => fact.isException).length;
  if (differsFromCount < MIN_DIFFERS_FROM) {
    errors.push(`${differsFromCount} facts with differsFrom, expected at least ${MIN_DIFFERS_FROM}`);
  }
  if (exceptionCount < MIN_EXCEPTIONS) {
    errors.push(`${exceptionCount} facts with isException, expected at least ${MIN_EXCEPTIONS}`);
  }

  return { errors, factCount: registry.facts.length, differsFromCount, exceptionCount };
}
