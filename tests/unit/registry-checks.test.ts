import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { catalogSchema } from '../../data-gen/schemas/catalog';
import { registrySchema, type Fact, type Registry } from '../../data-gen/schemas/registry';
import { worldSchema } from '../../data-gen/schemas/world';
import { validateRegistry } from '../../scripts/data-gen/registry-checks';
import { parseBlocklist } from '../../scripts/data-gen/text-checks';

const catalog = catalogSchema.parse(JSON.parse(readFileSync('data/catalog.json', 'utf8')));
const world = worldSchema.parse(JSON.parse(readFileSync('data/world.json', 'utf8')));
const blocklist = parseBlocklist(readFileSync('data-gen/blocklist.txt', 'utf8'));

const SLUGS = ['msa-harbor-point-foods', 'msa-lakeshore-retail'] as const;
const CATEGORIES = ['penalty', 'liability_cap', 'payment_terms', 'notice_period', 'other'] as const;
const twoMsas = catalog.filter((entry) => (SLUGS as readonly string[]).includes(entry.slug));
const deps = { catalog: twoMsas, world, blocklist };

function makeFact(docIndex: 0 | 1, seq: number): Fact {
  const amount = (docIndex + 1) * 100 + seq;
  return {
    factId: `${SLUGS[docIndex]}#0${seq}`,
    docSlug: SLUGS[docIndex],
    category: CATEGORIES[seq - 1]!,
    statement: `The agreement sets the amount for clause ${seq} at $${amount}.00 per shipment.`,
    value: `$${amount}.00`,
    aliases: [`$${amount}`],
    valueType: 'money',
    isException: seq <= 2,
    differsFrom: seq <= 4 ? [`${SLUGS[docIndex === 0 ? 1 : 0]}#0${seq}`] : [],
    entityIds: ['cust-harbor-point-foods'],
  };
}

// Two documents of five facts each: 8 differsFrom links and 4 exceptions, so it just passes.
function validRegistry(): Registry {
  const facts = [0, 1].flatMap((docIndex) =>
    [1, 2, 3, 4, 5].map((seq) => makeFact(docIndex as 0 | 1, seq)),
  );
  return { version: 'test', facts };
}

function withFact(factId: string, patch: Partial<Fact>): Registry {
  const registry = validRegistry();
  return {
    ...registry,
    facts: registry.facts.map((fact) => (fact.factId === factId ? { ...fact, ...patch } : fact)),
  };
}

function errorsOf(registry: Registry): string[] {
  return validateRegistry(registry, deps).errors;
}

describe('validateRegistry', () => {
  it('passes a valid registry and reports its counts', () => {
    expect(validateRegistry(validRegistry(), deps)).toEqual({
      errors: [],
      factCount: 10,
      differsFromCount: 8,
      exceptionCount: 4,
    });
  });

  it('requires the short form as an alias of a whole-dollar amount', () => {
    const errors = errorsOf(
      withFact('msa-harbor-point-foods#01', {
        value: '$12,500.00',
        aliases: ['twelve thousand five hundred dollars'],
      }),
    );

    expect(errors).toEqual([expect.stringMatching(/#01.*\$12,500/)]);
  });

  it('accepts an amount with cents and no shorter alias', () => {
    const registry = withFact('msa-harbor-point-foods#05', {
      value: '$1.85',
      aliases: ['1.85 dollars'],
    });

    expect(errorsOf(registry)).toEqual([]);
  });

  it('rejects two documents with the same penalty', () => {
    const errors = errorsOf(
      withFact('msa-lakeshore-retail#01', { value: '$101.00', aliases: ['$101'], differsFrom: [] }),
    );

    expect(errors.some((error) => error.includes('penalty') && error.includes('$101.00'))).toBe(
      true,
    );
  });

  it('rejects two documents with the same liability cap', () => {
    const errors = errorsOf(
      withFact('msa-lakeshore-retail#02', { value: '$102.00', aliases: ['$102'], differsFrom: [] }),
    );

    expect(errors.some((error) => error.includes('liability_cap'))).toBe(true);
  });

  it('rejects an ISO date in a date value', () => {
    const errors = errorsOf(
      withFact('msa-harbor-point-foods#05', {
        valueType: 'date',
        value: '2026-04-15',
        aliases: ['April 15, 2026'],
      }),
    );

    expect(errors.some((error) => error.includes('#05') && error.includes('ISO'))).toBe(true);
  });

  it('rejects an ISO date anywhere else in a fact', () => {
    const errors = errorsOf(
      withFact('msa-harbor-point-foods#05', {
        statement: 'The agreement takes effect on 2026-04-15 for all shipments.',
      }),
    );

    expect(errors).toEqual([expect.stringMatching(/#05.*ISO/)]);
  });

  it('requires the long form as an alias of a date', () => {
    const errors = errorsOf(
      withFact('msa-harbor-point-foods#05', {
        valueType: 'date',
        value: '04/05/2026',
        aliases: ['the fifth of April'],
      }),
    );

    expect(errors).toEqual([expect.stringMatching(/#05.*April 5, 2026/)]);
  });

  it('rejects an amount that is not in the canonical money format', () => {
    const errors = errorsOf(
      withFact('msa-harbor-point-foods#05', { value: '$250', aliases: ['$250.00'] }),
    );

    expect(errors).toEqual([expect.stringMatching(/#05.*money/)]);
  });

  it('rejects an unknown entity id', () => {
    const errors = errorsOf(
      withFact('msa-harbor-point-foods#05', { entityIds: ['cust-does-not-exist'] }),
    );

    expect(errors).toEqual([expect.stringMatching(/#05.*cust-does-not-exist/)]);
  });

  it('accepts lane and warehouse ids as entities', () => {
    const registry = withFact('msa-harbor-point-foods#05', {
      entityIds: ['lane-chi-mke', 'wh-chicago-west'],
    });

    expect(errorsOf(registry)).toEqual([]);
  });

  it('rejects a document with too few facts', () => {
    const registry = validRegistry();
    registry.facts = registry.facts.filter((fact) => fact.factId !== 'msa-lakeshore-retail#05');

    expect(errorsOf(registry)).toEqual([expect.stringMatching(/msa-lakeshore-retail.*4 facts/)]);
  });

  it('rejects a document with too many facts', () => {
    const registry = validRegistry();
    for (const seq of [6, 7, 8, 9]) {
      registry.facts.push({
        ...makeFact(0, 5),
        factId: `${SLUGS[0]}#0${seq}`,
      });
    }

    expect(errorsOf(registry)).toEqual([expect.stringMatching(/msa-harbor-point-foods.*9 facts/)]);
  });

  it('rejects a catalog document without facts', () => {
    const registry = validRegistry();
    registry.facts = registry.facts.filter((fact) => fact.docSlug !== SLUGS[1]);

    const { errors } = validateRegistry(registry, deps);

    expect(errors.some((error) => error.includes(`${SLUGS[1]}: 0 facts`))).toBe(true);
  });

  it('rejects a slug that is not in the catalog', () => {
    const errors = errorsOf(
      withFact('msa-harbor-point-foods#05', { docSlug: 'msa-unknown', factId: 'msa-unknown#05' }),
    );

    expect(errors.some((error) => error.includes('msa-unknown') && error.includes('catalog'))).toBe(
      true,
    );
  });

  it('rejects a duplicate fact id', () => {
    const registry = validRegistry();
    registry.facts.push(makeFact(0, 5));
    registry.facts = registry.facts.filter((fact) => fact.factId !== 'msa-lakeshore-retail#05');
    registry.facts.push({ ...makeFact(1, 5), factId: 'msa-lakeshore-retail#01' });

    expect(errorsOf(registry).some((error) => error.includes('duplicate'))).toBe(true);
  });

  it('rejects a fact id that does not start with its slug', () => {
    const errors = errorsOf(
      withFact('msa-harbor-point-foods#05', { factId: 'msa-lakeshore-retail#09' }),
    );

    expect(errors.some((error) => error.includes('msa-lakeshore-retail#09'))).toBe(true);
  });

  describe('differsFrom', () => {
    it('rejects a target that does not exist', () => {
      const errors = errorsOf(
        withFact('msa-harbor-point-foods#04', { differsFrom: ['msa-lakeshore-retail#99'] }),
      );

      expect(errors.some((error) => error.includes('msa-lakeshore-retail#99'))).toBe(true);
    });

    it('rejects a target in another category', () => {
      const errors = errorsOf(
        withFact('msa-harbor-point-foods#04', { differsFrom: ['msa-lakeshore-retail#03'] }),
      );

      expect(errors).toEqual([expect.stringMatching(/#04.*category/)]);
    });

    it('rejects a target with the same value', () => {
      const errors = errorsOf(
        withFact('msa-harbor-point-foods#04', { value: '$204.00', aliases: ['$204'] }),
      );

      expect(errors.some((error) => error.includes('#04') && error.includes('same value'))).toBe(
        true,
      );
    });

    it('rejects a target in the same document', () => {
      const errors = errorsOf(
        withFact('msa-harbor-point-foods#04', {
          category: 'payment_terms',
          differsFrom: ['msa-harbor-point-foods#03'],
        }),
      );

      expect(errors.some((error) => error.includes('another document'))).toBe(true);
    });

    it('rejects a target in a document of another type', () => {
      const carrierSlug = 'carrier-brightwater';
      const carrierFacts = [1, 2, 3, 4, 5].map((seq): Fact => ({
        ...makeFact(0, 5),
        factId: `${carrierSlug}#0${seq}`,
        docSlug: carrierSlug,
        category: seq === 1 ? 'notice_period' : 'other',
        value: `$${900 + seq}.00`,
        aliases: [`$${900 + seq}`],
      }));
      const registry = withFact('msa-harbor-point-foods#04', {
        differsFrom: [`${carrierSlug}#01`],
      });
      registry.facts.push(...carrierFacts);

      const { errors } = validateRegistry(registry, {
        ...deps,
        catalog: catalog.filter((entry) => [...SLUGS, carrierSlug].includes(entry.slug as never)),
      });

      expect(errors).toEqual([expect.stringMatching(/#04.*same type/)]);
    });
  });

  it('requires at least 8 differsFrom facts', () => {
    const errors = errorsOf(withFact('msa-harbor-point-foods#04', { differsFrom: [] }));

    expect(errors).toEqual([expect.stringMatching(/7 facts with differsFrom/)]);
  });

  it('requires at least 4 exceptions', () => {
    const errors = errorsOf(withFact('msa-harbor-point-foods#01', { isException: false }));

    expect(errors).toEqual([expect.stringMatching(/3 facts with isException/)]);
  });

  it('rejects a blocklisted name', () => {
    const errors = errorsOf(
      withFact('msa-harbor-point-foods#05', {
        statement: 'Freight may be handed to Landstar under this agreement.',
      }),
    );

    expect(errors).toEqual([expect.stringMatching(/[Bb]locklist.*Landstar/)]);
  });

  it('rejects a url, an email or a phone number', () => {
    const errors = errorsOf(
      withFact('msa-harbor-point-foods#05', {
        statement: 'Claims are filed by calling the desk at 312-555-0142 during business hours.',
      }),
    );

    expect(errors).toEqual([expect.stringMatching(/phone/)]);
  });

  it('rejects a company name outside the world bible', () => {
    const errors = errorsOf(
      withFact('msa-harbor-point-foods#05', {
        statement: 'Freight may be subcontracted to Bluepeak Transport LLC under this agreement.',
      }),
    );

    expect(errors).toEqual([expect.stringMatching(/#05.*Bluepeak Transport LLC/)]);
  });

  it('accepts company names from the world bible', () => {
    const registry = withFact('msa-harbor-point-foods#05', {
      statement:
        'Ridgeline Freight, LLC serves Harbor Point Foods, Inc. and may use Brightwater Carriers LLC.',
    });

    expect(errorsOf(registry)).toEqual([]);
  });
});

describe('data/registry.json', () => {
  it('passes every registry rule', () => {
    const registry = registrySchema.parse(JSON.parse(readFileSync('data/registry.json', 'utf8')));

    const report = validateRegistry(registry, { catalog, world, blocklist });

    expect(report.errors).toEqual([]);
    expect(report.factCount).toBeGreaterThanOrEqual(120);
    expect(report.factCount).toBeLessThanOrEqual(192);
  });

  it('gives every MSA a different penalty', () => {
    const registry = registrySchema.parse(JSON.parse(readFileSync('data/registry.json', 'utf8')));
    const msaSlugs = catalog.filter((entry) => entry.type === 'msa').map((entry) => entry.slug);

    const penalties = registry.facts.filter(
      (fact) => fact.category === 'penalty' && msaSlugs.includes(fact.docSlug),
    );

    expect(new Set(penalties.map((fact) => fact.docSlug)).size).toBe(msaSlugs.length);
    expect(new Set(penalties.map((fact) => fact.value)).size).toBe(penalties.length);
  });
});
