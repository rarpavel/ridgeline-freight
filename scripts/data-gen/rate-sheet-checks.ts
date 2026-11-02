import type { Fact } from '../../data-gen/schemas/registry';
import { rateSheetSchema, type RateSheet } from '../../data-gen/schemas/rate-sheet';
import type { World } from '../../data-gen/schemas/world';
import { checkFactMentions, MONEY, normalizeText, type DocumentReport } from './document-checks';
import { findCellErrors, renderRateSheetMarkdown } from './rate-sheet-markdown';

export type SheetKind = 'ltl' | 'ftl' | 'accessorials' | 'fuel_surcharge';

export const SHEET_KINDS: Record<string, SheetKind> = {
  'rate-ltl-midwest': 'ltl',
  'rate-ftl-dry-van': 'ftl',
  'rate-accessorials': 'accessorials',
  'rate-fuel-surcharge': 'fuel_surcharge',
};

const COLUMNS: Record<SheetKind, string[]> = {
  ltl: ['Lane', 'Origin', 'Destination', 'Miles', '<500 lb', '500-1,999 lb', '2,000-4,999 lb', 'Min Charge'],
  ftl: ['Lane', 'Origin', 'Destination', 'Miles', 'Equipment', 'Min Charge', 'Rate / Mile'],
  accessorials: ['Service', 'Unit', 'Charge', 'Notes'],
  fuel_surcharge: ['DOE Diesel Price Range (per gallon)', 'Surcharge (% of linehaul)'],
};

const DRY_VAN = 'Dry van';
const REEFER = 'Reefer';
const MIN_FUEL_STEPS = 12;
const MAX_FUEL_STEPS = 16;
const CANONICAL_MONEY = /^\$\d{1,3}(,\d{3})*\.\d{2}$/;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const FUEL_RANGE = /^\$(\d+\.\d{2})[–-]\$(\d+\.\d{2})$/;
const FUEL_OPEN_RANGE = /^\$(\d+\.\d{2}) and above$/;
const FUEL_TIER_VALUE = /^(\d+(?:\.\d+)?%) for \$(\d+\.\d{2})(?:–\$(\d+\.\d{2})|\+)\/gal$/;

const ACCESSORIAL_SERVICES: { service: RegExp; factId?: string }[] = [
  { service: /detention/i, factId: 'rate-accessorials#03' },
  { service: /layover/i },
  { service: /tonu|truck ordered/i },
  { service: /lumper/i, factId: 'rate-accessorials#01' },
  { service: /liftgate/i, factId: 'rate-accessorials#04' },
  { service: /inside delivery/i, factId: 'rate-accessorials#05' },
  { service: /residential/i },
  { service: /hazmat|hazardous/i, factId: 'rate-accessorials#06' },
  { service: /redelivery/i },
  { service: /storage/i },
];

export type RateSheetInput = {
  kind: SheetKind;
  title: string;
  effectiveDate: string;
  facts: Fact[];
  world: World;
  blocklist: string[];
};

export type RateSheetReport = Pick<DocumentReport, 'errors' | 'exceptionSentences'> & {
  // Null when the JSON is invalid or a cell cannot be rendered.
  markdown: string | null;
};

type RateTable = RateSheet['tables'][number];
type Row = string[];

const cell = (row: Row, index: number): string => row[index] ?? '';

function money(text: string): number {
  return Number(text.replace(/[$,]/g, ''));
}

function factValue(facts: Fact[], factId: string): string {
  const fact = facts.find((candidate) => candidate.factId === factId);
  if (!fact) throw new Error(`Fact not found: ${factId}`);
  return fact.value;
}

function checkLaneCells(rows: Row[], world: World): string[] {
  return rows.flatMap((row) => {
    const lane = world.lanes.find(({ id }) => id === cell(row, 0));
    if (!lane) return [`unknown lane "${cell(row, 0)}": use the ids in WORLD`];
    const matches =
      cell(row, 1) === lane.origin && cell(row, 2) === lane.destination && cell(row, 3) === String(lane.miles);
    return matches ? [] : [`${lane.id}: origin, destination and miles must match WORLD`];
  });
}

function findMissingLanes(rows: Row[], world: World): string[] {
  return world.lanes.filter(({ id }) => !rows.some((row) => cell(row, 0) === id)).map(({ id }) => id);
}

// Lanes may tie on miles, so only a strictly longer lane has to cost at least as much.
function checkCostGrowsWithMiles(rows: Row[], costOf: (row: Row) => number): string[] {
  const errors: string[] = [];
  for (const shorter of rows) {
    for (const longer of rows) {
      if (Number(cell(shorter, 3)) < Number(cell(longer, 3)) && costOf(shorter) > costOf(longer)) {
        errors.push(`${cell(shorter, 0)} costs more than the longer lane ${cell(longer, 0)}`);
      }
    }
  }
  return errors;
}

function checkMinCharge(rows: Row[], index: number, expected: string): string[] {
  return rows
    .filter((row) => cell(row, index) !== expected)
    .map((row) => `${cell(row, 0)}: Min Charge must be ${expected}`);
}

function checkLtl(rows: Row[], { facts, world }: RateSheetInput): string[] {
  const errors = [...checkLaneCells(rows, world)];
  const missing = findMissingLanes(rows, world);
  if (missing.length > 0) errors.push(`missing lanes: ${missing.join(', ')}`);
  errors.push(...checkMinCharge(rows, 7, factValue(facts, 'rate-ltl-midwest#03')));
  errors.push(...checkCostGrowsWithMiles(rows, (row) => money(cell(row, 4))));

  for (const row of rows) {
    const [light, medium, heavy] = [4, 5, 6].map((index) => money(cell(row, index)));
    if (light === undefined || medium === undefined || heavy === undefined || light < medium || medium < heavy) {
      errors.push(`${cell(row, 0)}: rates must fall as weight rises`);
    }
  }
  const laneRate = factValue(facts, 'rate-ltl-midwest#04');
  const factRow = rows.find((row) => cell(row, 0) === 'lane-chi-mke');
  if (factRow && cell(factRow, 4) !== laneRate) errors.push(`lane-chi-mke: "<500 lb" must be ${laneRate}`);
  return errors;
}

function checkFtl(rows: Row[], { facts, world }: RateSheetInput): string[] {
  const errors = [...checkLaneCells(rows, world)];
  const dryVan = rows.filter((row) => cell(row, 4) === DRY_VAN);
  const reefer = rows.filter((row) => cell(row, 4) === REEFER);
  if (dryVan.length + reefer.length !== rows.length) {
    errors.push(`Equipment must be "${DRY_VAN}" or "${REEFER}"`);
  }
  const missing = [...findMissingLanes(dryVan, world), ...findMissingLanes(reefer, world)];
  if (missing.length > 0) errors.push(`each lane needs a dry van and a reefer row, missing: ${missing.join(', ')}`);
  errors.push(...checkMinCharge(rows, 5, factValue(facts, 'rate-ftl-dry-van#03')));

  const linehaul = (row: Row): number => money(cell(row, 6)) * Number(cell(row, 3));
  errors.push(...checkCostGrowsWithMiles(dryVan, linehaul), ...checkCostGrowsWithMiles(reefer, linehaul));
  for (const row of reefer) {
    const dry = dryVan.find((candidate) => cell(candidate, 0) === cell(row, 0));
    if (dry && money(cell(row, 6)) < money(cell(dry, 6))) errors.push(`${cell(row, 0)}: reefer is below dry van`);
  }
  const laneRate = factValue(facts, 'rate-ftl-dry-van#04');
  const factRow = dryVan.find((row) => cell(row, 0) === 'lane-chi-msp');
  if (factRow && cell(factRow, 6) !== laneRate) errors.push(`lane-chi-msp dry van: Rate / Mile must be ${laneRate}`);
  return errors;
}

function checkAccessorials(rows: Row[], { facts }: RateSheetInput): string[] {
  return ACCESSORIAL_SERVICES.flatMap(({ service, factId }) => {
    const row = rows.find((candidate) => service.test(cell(candidate, 0)));
    if (!row) return [`missing service matching ${service.source}`];
    if (!factId) return [];
    const amount = factValue(facts, factId).match(MONEY)?.[0];
    // The cell may carry its unit too, as in "$60.00 per hour".
    return cell(row, 2).match(MONEY)?.[0] === amount ? [] : [`${cell(row, 0)}: Charge must be ${amount}`];
  });
}

type FuelStep = { label: string; lowCents: number; highCents: number | null; percent: number; percentText: string };

const toCents = (price: string | undefined): number => Math.round(Number(price) * 100);

function parseFuelStep(row: Row): FuelStep | null {
  const label = cell(row, 0);
  const percentText = cell(row, 1);
  if (!/^\d+(\.\d+)?%$/.test(percentText)) return null;
  const range = FUEL_RANGE.exec(label);
  const open = FUEL_OPEN_RANGE.exec(label);
  if (!range && !open) return null;
  return {
    label,
    lowCents: toCents(range?.[1] ?? open?.[1]),
    highCents: range ? toCents(range[2]) : null,
    percent: parseFloat(percentText),
    percentText,
  };
}

// Prices contiguous to the cent, surcharges strictly increasing, and only the last step open-ended.
export function checkFuelSteps(rows: Row[]): string[] {
  const errors: string[] = [];
  if (rows.length < MIN_FUEL_STEPS || rows.length > MAX_FUEL_STEPS) {
    errors.push(`${rows.length} fuel steps, expected ${MIN_FUEL_STEPS}-${MAX_FUEL_STEPS}`);
  }
  const steps = rows.map(parseFuelStep);
  steps.forEach((step, index) => {
    if (!step) {
      errors.push(`fuel row ${index + 1} must look like "$3.00–$3.49" (or "$4.50 and above") and "3.0%"`);
      return;
    }
    const isLast = index === steps.length - 1;
    if (step.highCents === null && !isLast) errors.push(`${step.label}: only the last step may be open-ended`);
    if (step.highCents !== null && step.highCents < step.lowCents) errors.push(`${step.label}: range is reversed`);
    const previous = steps[index - 1];
    if (!previous) return;
    if (previous.highCents !== null && step.lowCents !== previous.highCents + 1) {
      errors.push(`${previous.label} and ${step.label} are not contiguous`);
    }
    if (step.percent <= previous.percent) errors.push(`${step.label}: surcharge must increase`);
  });
  return errors;
}

function checkFuelTiers(rows: Row[], { facts }: RateSheetInput): string[] {
  const steps = rows.map(parseFuelStep);
  return facts.flatMap((fact) => {
    const tier = FUEL_TIER_VALUE.exec(fact.value);
    if (!tier) return [];
    const [, percent, low, high] = tier;
    const step = steps.find((candidate) => candidate?.lowCents === toCents(low));
    const highCents = high ? toCents(high) : null;
    return step?.highCents === highCents && step?.percentText === percent
      ? []
      : [`${fact.factId}: the table needs one step with exactly this range and percentage: "${fact.value}"`];
  });
}

function checkKindRules(rows: Row[], notes: string[], input: RateSheetInput): string[] {
  switch (input.kind) {
    case 'ltl':
      return checkLtl(rows, input);
    case 'ftl':
      return checkFtl(rows, input);
    case 'accessorials':
      return checkAccessorials(rows, input);
    case 'fuel_surcharge': {
      const weekly = notes.some((note) => /weekly/i.test(note)) ? [] : ['add a note on the weekly update basis'];
      return [...checkFuelSteps(rows), ...checkFuelTiers(rows, input), ...weekly];
    }
  }
}

function checkColumns(tables: RateTable[], kind: SheetKind): string[] {
  const expected = COLUMNS[kind].join(', ');
  return tables
    .filter((table) => table.columns.join(', ') !== expected)
    .map((table) => `"${table.title}": columns must be exactly [${expected}]`);
}

function checkFormats(markdown: string): string[] {
  const errors = (markdown.match(MONEY) ?? [])
    .filter((token) => !CANONICAL_MONEY.test(token))
    .map((token) => `${token}: write money as $1,234.56`);
  if (ISO_DATE.test(markdown)) errors.push('write dates as MM/DD/YYYY');
  return errors;
}

// A short alias such as "$2" also matches "$22.50", so the value itself has to be there.
function checkValuesVerbatim(markdown: string, facts: Fact[]): string[] {
  const normalized = normalizeText(markdown);
  return facts
    .filter((fact) => !normalized.includes(normalizeText(fact.value)))
    .map((fact) => `missing fact ${fact.factId}: "${fact.value}" must appear verbatim in a cell or note`);
}

export function checkRateSheet(sheet: RateSheet, input: RateSheetInput): RateSheetReport {
  const errors: string[] = [];
  if (sheet.title !== input.title) errors.push(`title must be exactly "${input.title}"`);
  if (sheet.effectiveDate !== input.effectiveDate) errors.push(`effectiveDate must be ${input.effectiveDate}`);
  if (sheet.tables.length === 0) errors.push('at least one table is required');

  const structure = [...sheet.tables.flatMap(findCellErrors), ...checkColumns(sheet.tables, input.kind)];
  if (structure.length > 0) return { errors: [...errors, ...structure], exceptionSentences: [], markdown: null };

  const markdown = renderRateSheetMarkdown(sheet);
  const factCheck = checkFactMentions(markdown, input.facts, input.blocklist);
  return {
    errors: [
      ...errors,
      ...factCheck.errors,
      ...checkValuesVerbatim(markdown, input.facts),
      ...checkFormats(markdown),
      ...checkKindRules(
        sheet.tables.flatMap((table) => table.rows),
        sheet.notes,
        input,
      ),
    ],
    exceptionSentences: factCheck.exceptionSentences,
    markdown,
  };
}

export function checkRateSheetJson(json: string, input: RateSheetInput): RateSheetReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { errors: ['output is not valid JSON'], exceptionSentences: [], markdown: null };
  }
  const result = rateSheetSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return { errors, exceptionSentences: [], markdown: null };
  }
  return checkRateSheet(result.data, input);
}
