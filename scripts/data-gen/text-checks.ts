const FORBIDDEN_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'url', pattern: /http/i },
  { label: 'email', pattern: /@/ },
  { label: 'phone', pattern: /(?:\(\d{3}\)\s*|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/ },
];

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
