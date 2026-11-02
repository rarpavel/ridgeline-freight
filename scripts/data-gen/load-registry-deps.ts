import { readFileSync } from 'node:fs';

import { catalogSchema } from '../../data-gen/schemas/catalog';
import { worldSchema } from '../../data-gen/schemas/world';
import type { RegistryDeps, RegistryReport } from './registry-checks';
import { parseBlocklist } from './text-checks';

export function loadRegistryDeps(): RegistryDeps {
  return {
    catalog: catalogSchema.parse(JSON.parse(readFileSync('data/catalog.json', 'utf8'))),
    world: worldSchema.parse(JSON.parse(readFileSync('data/world.json', 'utf8'))),
    blocklist: parseBlocklist(readFileSync('data-gen/blocklist.txt', 'utf8')),
  };
}

// Prints the report and returns whether the registry passed.
export function printRegistryReport(report: RegistryReport): boolean {
  console.log(
    `facts: ${report.factCount}, differsFrom: ${report.differsFromCount}, isException: ${report.exceptionCount}`,
  );
  for (const error of report.errors) console.error(error);
  console.log(report.errors.length === 0 ? 'registry ok' : `${report.errors.length} errors`);
  return report.errors.length === 0;
}
