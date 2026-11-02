import { readFileSync } from 'node:fs';

import { registrySchema } from '../../data-gen/schemas/registry';
import { describeError } from './describe-error';
import { loadRegistryDeps, printRegistryReport } from './load-registry-deps';
import { validateRegistry } from './registry-checks';

function main(): void {
  const registry = registrySchema.parse(JSON.parse(readFileSync('data/registry.json', 'utf8')));
  const passed = printRegistryReport(validateRegistry(registry, loadRegistryDeps()));
  if (!passed) process.exit(1);
}

try {
  main();
} catch (err: unknown) {
  console.error(describeError(err));
  process.exit(1);
}
