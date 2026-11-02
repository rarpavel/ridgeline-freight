import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { catalogSchema } from '../../data-gen/schemas/catalog';

const catalog: unknown = JSON.parse(readFileSync('data/catalog.json', 'utf8'));

function entries() {
  return catalogSchema.parse(catalog);
}

describe('data/catalog.json', () => {
  it('passes the schema: 24 entries, unique slugs, allowed roles', () => {
    expect(entries()).toHaveLength(24);
  });

  it('gives admin access to every document', () => {
    for (const entry of entries()) {
      expect(entry.roles, entry.slug).toContain('admin');
    }
  });

  it('contains no name from the blocklist', () => {
    const blocked = readFileSync('data-gen/blocklist.txt', 'utf8')
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line !== '' && !line.startsWith('#'));

    expect(blocked.length).toBeGreaterThan(0);
    for (const entry of entries()) {
      for (const name of blocked) {
        expect(entry.title.toLowerCase(), entry.slug).not.toContain(name);
      }
    }
  });
});

describe('catalogSchema', () => {
  const valid = entries();
  const first = valid[0];

  it('rejects a duplicate slug', () => {
    const result = catalogSchema.safeParse(valid.map((entry) => ({ ...entry, slug: first?.slug })));
    expect(result.success).toBe(false);
  });

  it('rejects a role outside the allowed list', () => {
    const [head, ...rest] = valid;
    const result = catalogSchema.safeParse([{ ...head, roles: ['finance'] }, ...rest]);
    expect(result.success).toBe(false);
  });

  it('rejects a catalog without exactly 24 entries', () => {
    expect(catalogSchema.safeParse(valid.slice(1)).success).toBe(false);
  });
});
