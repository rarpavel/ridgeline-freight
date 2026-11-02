import { z } from 'zod';

import type { CatalogEntry } from './catalog';

const OFFICER_COUNT = 4;
const CUSTOMER_COUNT = 6;
const CARRIER_COUNT = 4;
const LANE_COUNT = 10;
const WAREHOUSE_COUNT = 3;

const MIDWEST_STATES = ['IL', 'IN', 'IA', 'KS', 'MI', 'MN', 'MO', 'NE', 'ND', 'OH', 'SD', 'WI'] as const;
const midwestState = z.enum(MIDWEST_STATES);
const zipCode = z.string().regex(/^\d{5}$/);
const midwestCity = z.string().regex(/^[^,]+, [A-Z]{2}$/);

const companySchema = z.strictObject({
  name: z.literal('Ridgeline Freight, LLC'),
  hq: z.strictObject({
    street: z.string().min(1),
    city: z.literal('Chicago'),
    state: z.literal('IL'),
    zip: z.string().regex(/^606\d{2}$/),
  }),
  founded: z.literal('2009'),
  fiscalYearStart: z.literal('01/01'),
  officers: z
    .array(z.strictObject({ title: z.string().min(1), name: z.string().min(1) }))
    .length(OFFICER_COUNT),
});

const customerSchema = z.strictObject({
  id: z.string().regex(/^cust-[a-z0-9-]+$/),
  name: z.string().min(1),
  industry: z.string().min(1),
  city: z.string().min(1),
  state: midwestState,
  commodity: z.string().min(1),
  volumeBand: z.enum(['<1k', '1k-5k', '5k-20k']),
});

const carrierSchema = z.strictObject({
  id: z.string().regex(/^car-[a-z0-9-]+$/),
  name: z.string().min(1),
  equipment: z.array(z.string().min(1)).min(1),
  state: midwestState,
  fleetSizeBand: z.string().min(1),
});

const laneSchema = z.strictObject({
  id: z.string().regex(/^lane-[a-z0-9-]+$/),
  origin: midwestCity,
  destination: midwestCity,
  miles: z.number().int().positive(),
});

const warehouseSchema = z.strictObject({
  id: z.string().regex(/^wh-[a-z0-9-]+$/),
  name: z.string().min(1),
  street: z.string().min(1),
  city: z.string().min(1),
  state: midwestState,
  zip: zipCode,
  docks: z.number().int().positive(),
});

const glossarySchema = z.strictObject({
  detention: z.string().min(1),
  layover: z.string().min(1),
  accessorial: z.string().min(1),
  tonu: z.string().min(1),
  lumperFee: z.string().min(1),
  osd: z.string().min(1),
  hazmat: z.string().min(1),
  reefer: z.string().min(1),
});

export const worldSchema = z.strictObject({
  company: companySchema,
  customers: z.array(customerSchema).length(CUSTOMER_COUNT),
  carriers: z.array(carrierSchema).length(CARRIER_COUNT),
  lanes: z.array(laneSchema).length(LANE_COUNT),
  warehouses: z.array(warehouseSchema).length(WAREHOUSE_COUNT),
  glossary: glossarySchema,
});

export type World = z.infer<typeof worldSchema>;

export type WorldEntity = { id: string; name: string };

function entityFromEntry(entry: CatalogEntry, slugPrefix: string, idPrefix: string): WorldEntity {
  const name = entry.title.split(' — ')[1];
  if (!name) throw new Error(`Catalog title has no entity name: ${entry.title}`);
  return { id: `${idPrefix}-${entry.slug.replace(`${slugPrefix}-`, '')}`, name };
}

// The catalog is the source of customer and carrier names, which were checked against real
// businesses (SYNTHETIC_DATA.md §4), and every id is derived from a document slug.
export function catalogEntities(catalog: CatalogEntry[]): {
  customers: WorldEntity[];
  carriers: WorldEntity[];
} {
  return {
    customers: catalog
      .filter((entry) => entry.type === 'msa')
      .map((entry) => entityFromEntry(entry, 'msa', 'cust')),
    carriers: catalog
      .filter((entry) => entry.type === 'carrier_agreement')
      .map((entry) => entityFromEntry(entry, 'carrier', 'car')),
  };
}

function sameEntities(actual: WorldEntity[], expected: WorldEntity[]): boolean {
  const key = (entity: WorldEntity) => `${entity.id}|${entity.name}`;
  const expectedKeys = new Set(expected.map(key));
  return actual.length === expected.length && actual.every((entity) => expectedKeys.has(key(entity)));
}

export function worldMatchesCatalog(world: World, catalog: CatalogEntry[]): boolean {
  const { customers, carriers } = catalogEntities(catalog);
  return sameEntities(world.customers, customers) && sameEntities(world.carriers, carriers);
}
