import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { qualifiedPlaceName } from './placeName';

describe('qualifiedPlaceName', () => {
  it('qualifies a US place with its state, not its postcode', () => {
    expect(qualifiedPlaceName('Monument Valley', 'Monument Valley, UT 84536, USA'))
      .toBe('Monument Valley, UT');
    expect(qualifiedPlaceName('Marfa', 'Marfa, TX 79843, USA')).toBe('Marfa, TX');
  });

  it('handles a state with no postcode', () => {
    expect(qualifiedPlaceName('Big Bend National Park', 'Big Bend National Park, TX, USA'))
      .toBe('Big Bend National Park, TX');
  });

  it('uses the country when there is no state', () => {
    expect(qualifiedPlaceName('Girona', 'Girona, Spain')).toBe('Girona, Spain');
  });

  it('never repeats itself', () => {
    expect(qualifiedPlaceName('Singapore', 'Singapore')).toBe('Singapore');
    expect(qualifiedPlaceName('Marfa, TX', 'Marfa, TX 79843, USA')).toBe('Marfa, TX');
  });

  it('returns the label untouched when there is nothing to qualify with', () => {
    expect(qualifiedPlaceName('Somewhere', null)).toBe('Somewhere');
    expect(qualifiedPlaceName('Somewhere', '')).toBe('Somewhere');
    expect(qualifiedPlaceName('Somewhere', '12345')).toBe('Somewhere');
  });

  it('never invents a name from nothing', () => {
    expect(qualifiedPlaceName(null, 'Marfa, TX, USA')).toBeNull();
    expect(qualifiedPlaceName('   ', 'Marfa, TX, USA')).toBeNull();
  });

  it('keeps a name the user already qualified, as they wrote it', () => {
    expect(qualifiedPlaceName('Bergen, Norway', 'Bergen, Norway')).toBe('Bergen, Norway');
    expect(qualifiedPlaceName('Camping La Vallée, Annecy', 'Rte de Lyon, 74000 Annecy, France')).toBe(
      'Camping La Vallée, Annecy'
    );
  });

  it('does not turn a bare postcode part into a qualifier', () => {
    expect(qualifiedPlaceName('Placeville', 'Placeville, 84536, USA')).toBe('Placeville');
  });
});

/**
 * resolve_place names a place in the user's words. Google's displayName is a
 * business name Google's ToS (§3.2.3) does not let us store, so neither the
 * `label` nor the `name_for_leg` Penny copies onto a leg or stop may come from
 * it (2026-10-07).
 */
describe("resolve_place's stored names", () => {
  const claude = readFileSync(join(__dirname, 'claude.ts'), 'utf8');
  const start = claude.indexOf('async function executeResolvePlace');
  const resolved = claude.slice(start, claude.indexOf("case 'ambiguous':", start));

  it('labels the place with the query', () => {
    expect(resolved).toContain('label: input.query.trim(),');
    expect(resolved).not.toContain('label: result.match.label');
  });

  it('qualifies the query, not the Google label, for name_for_leg', () => {
    expect(resolved).toContain('name_for_leg: qualifiedPlaceName(input.query, result.match.address)');
  });
});
