import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { catalogSchema } from '../../data-gen/schemas/catalog';
import {
  catalogEntities,
  worldMatchesCatalog,
  worldSchema,
  type World,
} from '../../data-gen/schemas/world';
import {
  findBlocklistHits,
  findForbiddenPatterns,
  parseBlocklist,
} from '../../scripts/data-gen/text-checks';

const catalog = catalogSchema.parse(JSON.parse(readFileSync('data/catalog.json', 'utf8')));
const raw = readFileSync('data/world.json', 'utf8');

function world(): World {
  return worldSchema.parse(JSON.parse(raw));
}

describe('catalogEntities', () => {
  it('derives ids from document slugs and names from titles', () => {
    const { customers, carriers } = catalogEntities(catalog);

    expect(customers).toHaveLength(6);
    expect(carriers).toHaveLength(4);
    expect(customers).toContainEqual({
      id: 'cust-harbor-point-foods',
      name: 'Harbor Point Foods, Inc.',
    });
    expect(carriers).toContainEqual({
      id: 'car-granite-fork-intermodal',
      name: 'Granite Fork Intermodal',
    });
  });
});

describe('data/world.json', () => {
  it('passes the schema', () => {
    expect(world().customers).toHaveLength(6);
    expect(world().carriers).toHaveLength(4);
  });

  it('holds exactly the customers and carriers of the catalog', () => {
    expect(worldMatchesCatalog(world(), catalog)).toBe(true);
  });

  it('contains no url, email, phone number or blocklisted name', () => {
    const blocklist = parseBlocklist(readFileSync('data-gen/blocklist.txt', 'utf8'));

    expect(findForbiddenPatterns(raw)).toEqual([]);
    expect(findBlocklistHits(raw, blocklist)).toEqual([]);
  });

  it('uses unique lane ids and distinct lane endpoints', () => {
    const lanes = world().lanes;

    expect(new Set(lanes.map((lane) => lane.id)).size).toBe(lanes.length);
    for (const lane of lanes) {
      expect(lane.origin, lane.id).not.toBe(lane.destination);
    }
  });
});

describe('worldSchema', () => {
  it('rejects a hq zip outside 606xx', () => {
    const invalid = world();
    invalid.company.hq.zip = '53202';

    expect(worldSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects a seventh customer', () => {
    const invalid = world();
    invalid.customers.push({ ...invalid.customers[0]! });

    expect(worldSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('worldMatchesCatalog', () => {
  it('rejects a renamed carrier', () => {
    const renamed = world();
    renamed.carriers[0]!.name = 'Some Other Carrier LLC';

    expect(worldMatchesCatalog(renamed, catalog)).toBe(false);
  });
});
