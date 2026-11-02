import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { RateSheet } from '../../data-gen/schemas/rate-sheet';
import { registrySchema } from '../../data-gen/schemas/registry';
import { worldSchema } from '../../data-gen/schemas/world';
import {
  checkFuelSteps,
  checkRateSheet,
  checkRateSheetJson,
  type RateSheetInput,
  type SheetKind,
} from '../../scripts/data-gen/rate-sheet-checks';
import {
  renderMarkdownTable,
  renderRateSheetMarkdown,
} from '../../scripts/data-gen/rate-sheet-markdown';

const world = worldSchema.parse(JSON.parse(readFileSync('data/world.json', 'utf8')));
const registry = registrySchema.parse(JSON.parse(readFileSync('data/registry.json', 'utf8')));

const EFFECTIVE_DATE = '04/01/2026';
const LTL_COLUMNS = [
  'Lane',
  'Origin',
  'Destination',
  'Miles',
  '<500 lb',
  '500-1,999 lb',
  '2,000-4,999 lb',
  'Min Charge',
];
const FTL_COLUMNS = [
  'Lane',
  'Origin',
  'Destination',
  'Miles',
  'Equipment',
  'Min Charge',
  'Rate / Mile',
];
const FUEL_COLUMNS = ['DOE Diesel Price Range (per gallon)', 'Surcharge (% of linehaul)'];

const usd = (amount: number): string => `$${amount.toFixed(2)}`;
const laneCells = (lane: (typeof world.lanes)[number]): string[] => [
  lane.id,
  lane.origin,
  lane.destination,
  String(lane.miles),
];

function ltlRows(): string[][] {
  return world.lanes.map((lane) => {
    const rate = 22.5 + (lane.miles - 92) * 0.01;
    return [...laneCells(lane), usd(rate), usd(rate - 2), usd(rate - 4), '$150.00'];
  });
}

function ftlRows(): string[][] {
  return world.lanes.flatMap((lane) => [
    [...laneCells(lane), 'Dry van', '$350.00', '$2.10'],
    [...laneCells(lane), 'Reefer', '$350.00', '$2.40'],
  ]);
}

function accessorialRows(): string[][] {
  return [
    ['Detention', 'per hour', '$60.00', 'After free time'],
    ['Layover', 'per day', '$300.00', 'Overnight'],
    ['Truck Ordered Not Used (TONU)', 'per occurrence', '$400.00', 'After dispatch'],
    ['Lumper', 'per stop', '$125.00', 'At cost'],
    ['Liftgate', 'per occurrence', '$75.00', 'On request'],
    ['Inside delivery', 'per pallet', '$40.00', 'On request'],
    ['Residential delivery', 'per stop', '$90.00', 'On request'],
    ['Hazmat handling', 'per shipment', '$200.00', 'With paperwork'],
    ['Redelivery', 'per attempt', '$110.00', 'On request'],
    ['Storage', 'per pallet per day', '$15.00', 'After free days'],
  ];
}

function fuelRows(): string[][] {
  const lower = Array.from({ length: 10 }, (_, index) => {
    const low = 2 + index / 10;
    return [`${usd(low)}–${usd(low + 0.09)}`, `${(0.5 + index * 0.25).toFixed(2)}%`];
  });
  return [
    ...lower,
    ['$3.00–$3.49', '3.0%'],
    ['$3.50–$3.99', '5.5%'],
    ['$4.00–$4.49', '7.5%'],
    ['$4.50 and above', '10.0%'],
  ];
}

const SHEETS: Record<
  SheetKind,
  { slug: string; title: string; columns: string[]; rows: () => string[][] }
> = {
  ltl: {
    slug: 'rate-ltl-midwest',
    title: 'Rate Sheet — Regional LTL, Midwest Lanes (2026)',
    columns: LTL_COLUMNS,
    rows: ltlRows,
  },
  ftl: {
    slug: 'rate-ftl-dry-van',
    title: 'Rate Sheet — Full Truckload Dry Van (2026)',
    columns: FTL_COLUMNS,
    rows: ftlRows,
  },
  accessorials: {
    slug: 'rate-accessorials',
    title: 'Accessorial Fee Schedule (2026)',
    columns: ['Service', 'Unit', 'Charge', 'Notes'],
    rows: accessorialRows,
  },
  fuel_surcharge: {
    slug: 'rate-fuel-surcharge',
    title: 'Fuel Surcharge Table (2026)',
    columns: FUEL_COLUMNS,
    rows: fuelRows,
  },
};

function makeInput(kind: SheetKind): RateSheetInput {
  const { slug, title } = SHEETS[kind];
  return {
    kind,
    title,
    effectiveDate: EFFECTIVE_DATE,
    facts: registry.facts.filter((fact) => fact.docSlug === slug),
    world,
    blocklist: ['Landstar'],
  };
}

function makeSheet(kind: SheetKind, rows: string[][] = SHEETS[kind].rows()): RateSheet {
  const { title, columns } = SHEETS[kind];
  const facts = makeInput(kind).facts;
  return {
    title,
    effectiveDate: EFFECTIVE_DATE,
    intro: 'These rates apply to shipments tendered under the applicable agreement.',
    tables: [{ title: 'Rates', columns, rows }],
    notes: [
      ...facts.map((fact) => `${fact.statement} (${fact.value})`),
      'Surcharges update on a weekly basis.',
    ],
  };
}

const errorsOf = (kind: SheetKind, rows?: string[][]): string[] =>
  checkRateSheet(makeSheet(kind, rows), makeInput(kind)).errors;

describe('renderMarkdownTable', () => {
  it('renders a header, a delimiter row and one line per row', () => {
    const table = { title: 'T', columns: ['Service', 'Charge'], rows: [['Liftgate', '$75.00']] };
    expect(renderMarkdownTable(table)).toBe(
      '| Service | Charge |\n| --- | --- |\n| Liftgate | $75.00 |',
    );
  });

  it('throws when a row has the wrong number of cells', () => {
    const table = { title: 'T', columns: ['Service', 'Charge'], rows: [['Liftgate']] };
    expect(() => renderMarkdownTable(table)).toThrow('1 cells, expected 2');
  });

  it('throws when a cell contains a pipe', () => {
    const table = { title: 'T', columns: ['Service', 'Charge'], rows: [['Lift|gate', '$75.00']] };
    expect(() => renderMarkdownTable(table)).toThrow('Lift|gate');
  });
});

describe('renderRateSheetMarkdown', () => {
  it('renders the title, date, intro, one section per table and numbered notes', () => {
    const markdown = renderRateSheetMarkdown({
      title: 'Sheet',
      effectiveDate: EFFECTIVE_DATE,
      intro: 'Intro.',
      tables: [{ title: 'Rates', columns: ['A', 'B'], rows: [['1', '2']] }],
      notes: ['First.', 'Second.'],
    });
    expect(markdown).toBe(
      `# Sheet\n\nEffective date: ${EFFECTIVE_DATE}\n\nIntro.\n\n## Rates\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n## Notes\n\n1. First.\n2. Second.`,
    );
  });
});

describe('checkRateSheet', () => {
  it.each(['ltl', 'ftl', 'accessorials', 'fuel_surcharge'] as const)(
    'accepts a valid %s sheet',
    (kind) => {
      expect(errorsOf(kind)).toEqual([]);
    },
  );

  it('reports a fact whose value is missing even when a short alias matches', () => {
    const input = makeInput('ltl');
    const sheet = makeSheet('ltl');
    sheet.notes = sheet.notes.filter((note) => !note.includes('per pound'));
    const { errors } = checkRateSheet(sheet, input);
    expect(errors).toContainEqual(expect.stringContaining('missing fact rate-ltl-midwest#05'));
  });

  it('rejects a sheet without tables', () => {
    const sheet = { ...makeSheet('accessorials'), tables: [] };
    const { errors, markdown } = checkRateSheet(sheet, makeInput('accessorials'));
    expect(errors).toContain('at least one table is required');
    expect(markdown).not.toBeNull();
  });

  it('rejects other columns, and does not render them', () => {
    const sheet = makeSheet('accessorials');
    sheet.tables = sheet.tables.map((table) => ({
      ...table,
      columns: ['Service', 'Unit', 'Fee', 'Notes'],
    }));
    const { errors, markdown } = checkRateSheet(sheet, makeInput('accessorials'));
    expect(errors[0]).toContain('columns must be exactly');
    expect(markdown).toBeNull();
  });

  it('rejects money without cents', () => {
    const rows = accessorialRows();
    rows[1] = ['Layover', 'per day', '$300', 'Overnight'];
    expect(errorsOf('accessorials', rows)).toContain('$300: write money as $1,234.56');
  });

  it('rejects a charge that differs from its fact', () => {
    const rows = accessorialRows();
    rows[4] = ['Liftgate', 'per occurrence', '$80.00', 'On request'];
    expect(errorsOf('accessorials', rows)).toContain('Liftgate: Charge must be $75.00');
  });

  it('rejects a missing accessorial service', () => {
    const rows = accessorialRows().filter(([service]) => service !== 'Redelivery');
    expect(errorsOf('accessorials', rows)).toContainEqual(expect.stringContaining('redelivery'));
  });
});

describe('ftl lanes', () => {
  it('rejects a table missing one lane from the world', () => {
    const rows = ftlRows().filter(([lane]) => lane !== 'lane-oma-kck');
    expect(errorsOf('ftl', rows)).toContainEqual(
      expect.stringContaining('missing: lane-oma-kck, lane-oma-kck'),
    );
  });

  it('rejects a lane that is not in the world', () => {
    const rows = ftlRows();
    rows[0] = ['L-01', 'Chicago, IL', 'Milwaukee, WI', '92', 'Dry van', '$350.00', '$2.10'];
    expect(errorsOf('ftl', rows)).toContainEqual(expect.stringContaining('unknown lane "L-01"'));
  });

  it('rejects miles that differ from the world', () => {
    const rows = ftlRows();
    rows[0] = ['lane-chi-mke', 'Chicago, IL', 'Milwaukee, WI', '95', 'Dry van', '$350.00', '$2.10'];
    expect(errorsOf('ftl', rows)).toContain(
      'lane-chi-mke: origin, destination and miles must match WORLD',
    );
  });

  it('rejects a reefer rate below dry van', () => {
    const rows = ftlRows().map((row) =>
      row[4] === 'Reefer' ? [...row.slice(0, 6), '$2.00'] : row,
    );
    expect(errorsOf('ftl', rows)).toContain('lane-chi-mke: reefer is below dry van');
  });

  it('rejects a longer lane that costs less', () => {
    const rows = ftlRows().map((row) =>
      row[0] === 'lane-chi-msp' && row[4] === 'Dry van' ? [...row.slice(0, 6), '$0.20'] : row,
    );
    expect(errorsOf('ftl', rows)).toContainEqual(
      expect.stringContaining('the longer lane lane-chi-msp'),
    );
  });

  it('rejects a Rate / Mile that rises with miles', () => {
    const rows = ftlRows().map((row) =>
      row[0] === 'lane-chi-mke' && row[4] === 'Dry van' ? [...row.slice(0, 6), '$1.40'] : row,
    );
    expect(errorsOf('ftl', rows)).toContainEqual(
      expect.stringContaining('lane-chi-mke has a lower Rate / Mile than the longer lane'),
    );
  });

  it('rejects a lane rate that differs from its fact', () => {
    const rows = ftlRows().map((row) =>
      row[0] === 'lane-chi-msp' && row[4] === 'Dry van' ? [...row.slice(0, 6), '$2.20'] : row,
    );
    expect(errorsOf('ftl', rows)).toContain('lane-chi-msp dry van: Rate / Mile must be $2.10');
  });
});

describe('ltl lanes', () => {
  it('rejects a minimum charge that differs from its fact', () => {
    const rows = ltlRows();
    rows[0] = [...(rows[0] ?? []).slice(0, 7), '$175.00'];
    expect(errorsOf('ltl', rows)).toContain('lane-chi-mke: Min Charge must be $150.00');
  });

  it('rejects a rate that rises with weight', () => {
    const rows = ltlRows();
    const [lane, origin, destination, miles] = rows[0] ?? [];
    rows[0] = [lane!, origin!, destination!, miles!, '$22.50', '$23.00', '$18.50', '$150.00'];
    expect(errorsOf('ltl', rows)).toContain('lane-chi-mke: rates must fall as weight rises');
  });
});

describe('checkFuelSteps', () => {
  it('accepts contiguous, increasing steps with one open-ended last step', () => {
    expect(checkFuelSteps(fuelRows())).toEqual([]);
  });

  it('rejects a gap between price ranges', () => {
    const rows = fuelRows();
    rows[10] = ['$3.05–$3.49', '3.0%'];
    expect(checkFuelSteps(rows)).toContain('$2.90–$2.99 and $3.05–$3.49 are not contiguous');
  });

  it('rejects an overlap between price ranges', () => {
    const rows = fuelRows();
    rows[10] = ['$2.95–$3.49', '3.0%'];
    expect(checkFuelSteps(rows)).toContain('$2.90–$2.99 and $2.95–$3.49 are not contiguous');
  });

  it('rejects a surcharge that does not increase', () => {
    const rows = fuelRows();
    rows[11] = ['$3.50–$3.99', '3.0%'];
    expect(checkFuelSteps(rows)).toContain('$3.50–$3.99: surcharge must increase');
  });

  it('rejects an open-ended step before the last one', () => {
    const rows = fuelRows();
    rows[10] = ['$3.00 and above', '3.0%'];
    expect(checkFuelSteps(rows)).toContain('$3.00 and above: only the last step may be open-ended');
  });

  it('rejects too few steps', () => {
    expect(checkFuelSteps(fuelRows().slice(-4))).toContainEqual(
      expect.stringContaining('4 fuel steps'),
    );
  });

  it('rejects a row in another format', () => {
    const rows = fuelRows();
    rows[0] = ['2 to 2.09 dollars', '0.50%'];
    expect(checkFuelSteps(rows)).toContainEqual(expect.stringContaining('fuel row 1'));
  });
});

describe('fuel tiers', () => {
  it('rejects a tier whose percentage differs from its fact', () => {
    const rows = fuelRows();
    rows[12] = ['$4.00–$4.49', '8.0%'];
    expect(errorsOf('fuel_surcharge', rows)).toContainEqual(
      expect.stringContaining('rate-fuel-surcharge#04'),
    );
  });

  it('requires a note on the weekly update basis', () => {
    const sheet = makeSheet('fuel_surcharge');
    sheet.notes = sheet.notes.filter((note) => !/weekly/i.test(note));
    const { errors } = checkRateSheet(sheet, makeInput('fuel_surcharge'));
    expect(errors).toContain('add a note on the weekly update basis');
  });
});

describe('committed rate sheets', () => {
  it.each(['ltl', 'ftl', 'accessorials', 'fuel_surcharge'] as const)(
    '%s passes and matches its Markdown',
    (kind) => {
      const { slug } = SHEETS[kind];
      const json = readFileSync(`data/generated/rate-sheets/${slug}.json`, 'utf8');
      const { errors, markdown } = checkRateSheetJson(json, makeInput(kind));
      expect(errors).toEqual([]);
      expect(readFileSync(`data/generated/md/${slug}.md`, 'utf8')).toBe(`${markdown}\n`);
    },
  );
});

describe('checkRateSheetJson', () => {
  it('reports text that is not JSON', () => {
    expect(checkRateSheetJson('not json', makeInput('ltl')).errors).toEqual([
      'output is not valid JSON',
    ]);
  });

  it('reports a row with the wrong number of cells through the schema', () => {
    const sheet = makeSheet('ltl', [['lane-chi-mke']]);
    const { errors, markdown } = checkRateSheetJson(JSON.stringify(sheet), makeInput('ltl'));
    expect(errors[0]).toContain('every row must have one cell per column');
    expect(markdown).toBeNull();
  });

  it('accepts a valid sheet and returns its Markdown', () => {
    const { errors, markdown } = checkRateSheetJson(
      JSON.stringify(makeSheet('accessorials')),
      makeInput('accessorials'),
    );
    expect(errors).toEqual([]);
    expect(markdown).toContain('# Accessorial Fee Schedule (2026)');
  });
});
