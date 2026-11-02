const FORBIDDEN_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'url', pattern: /http/i },
  { label: 'email', pattern: /@/ },
  { label: 'phone', pattern: /(?:\(\d{3}\)\s*|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/ },
];

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const VALID_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const SLASH_DATE = /(?<![\d/])\d{1,4}\/\d{1,2}\/\d{1,4}(?![\d/])/g;
const WRITTEN_DATE =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/g;
const VALID_AMOUNT = /^\$\d{1,3}(,\d{3})*(\.\d{2})?$/;
// Ends on a digit, so the comma or period after an amount is not part of it.
const AMOUNT = /\$[\d.,]*\d/g;
const NON_US_CURRENCY = /[€£]/g;

function uniqueMatches(text: string, pattern: RegExp): string[] {
  return [...new Set(text.match(pattern) ?? [])];
}

export function findFormatErrors(text: string): string[] {
  const dates = [
    ...uniqueMatches(text, SLASH_DATE).filter((date) => !VALID_DATE.test(date)),
    ...uniqueMatches(text, WRITTEN_DATE),
  ];
  const amounts = uniqueMatches(text, AMOUNT).filter((amount) => !VALID_AMOUNT.test(amount));
  return [
    ...uniqueMatches(text, ISO_DATE).map((date) => `ISO date ${date}: dates must be MM/DD/YYYY`),
    ...dates.map((date) => `date ${date}: dates must be MM/DD/YYYY`),
    ...amounts.map((amount) => `amount ${amount}: amounts must look like $1,250.00`),
    ...uniqueMatches(text, NON_US_CURRENCY).map((symbol) => `non-US currency symbol ${symbol}`),
  ];
}

// Models sometimes wrap a JSON reply in a Markdown code fence.
export function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
}

export function parseBlocklist(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

export function findBlocklistHits(text: string, blocklist: string[]): string[] {
  const lowered = text.toLowerCase();
  return blocklist.filter((name) => lowered.includes(name.toLowerCase()));
}

export function findForbiddenPatterns(text: string): string[] {
  return FORBIDDEN_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}
