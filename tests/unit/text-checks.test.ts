import { describe, expect, it } from 'vitest';

import {
  findBlocklistHits,
  findForbiddenPatterns,
  parseBlocklist,
} from '../../scripts/data-gen/text-checks';

describe('parseBlocklist', () => {
  it('drops comments and blank lines and trims names', () => {
    expect(parseBlocklist('# Carriers\n\nLandstar\n  DHL  \n')).toEqual(['Landstar', 'DHL']);
  });
});

describe('findBlocklistHits', () => {
  const blocklist = ['Landstar', 'Best Buy'];

  it('matches names case-insensitively inside longer text', () => {
    expect(findBlocklistHits('Hauled by LANDSTAR Inc.', blocklist)).toEqual(['Landstar']);
  });

  it('returns every name that matches', () => {
    expect(findBlocklistHits('landstar and best buy', blocklist)).toEqual(['Landstar', 'Best Buy']);
  });

  it('returns nothing for clean text', () => {
    expect(findBlocklistHits('Brightwater Carriers LLC', blocklist)).toEqual([]);
  });
});

describe('findForbiddenPatterns', () => {
  it.each([
    ['See https://example.test for details', 'url'],
    ['Write to dispatch@ridgeline.test', 'email'],
    ['Call 312-555-0142 today', 'phone'],
    ['Call 312.555.0142 today', 'phone'],
    ['Call (312) 555-0142 today', 'phone'],
  ])('flags %s', (text, label) => {
    expect(findForbiddenPatterns(text)).toEqual([label]);
  });

  it('leaves zips, mileages and street numbers alone', () => {
    expect(findForbiddenPatterns('2750 Tamarack Ave, Chicago, IL 60632, 92 miles')).toEqual([]);
  });
});
