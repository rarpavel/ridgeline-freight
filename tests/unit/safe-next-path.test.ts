import { describe, expect, it } from 'vitest';

import { safeNextPath } from '@/lib/safe-next-path';

describe('safeNextPath', () => {
  it.each([
    ['/chat', '/chat'],
    ['/documents/abc?chunk=1#c1', '/documents/abc?chunk=1#c1'],
    ['/admin/eval', '/admin/eval'],
  ])('keeps the local path %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    ['missing', null],
    ['undefined', undefined],
    ['empty', ''],
    ['absolute URL', 'https://evil.test/chat'],
    ['protocol-relative', '//evil.test/chat'],
    ['an empty host', '//'],
    ['an empty host via backslash', '/\\'],
    ['an unparsable host', '//['],
    ['backslash host', '/\\evil.test/chat'],
    ['double backslash', '\\\\evil.test'],
    ['tab-smuggled host', '/\t/evil.test'],
    ['newline-smuggled host', '/\n/evil.test'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['relative path', 'chat'],
  ])('falls back to /chat for %s', (_label, input) => {
    expect(safeNextPath(input)).toBe('/chat');
  });
});
