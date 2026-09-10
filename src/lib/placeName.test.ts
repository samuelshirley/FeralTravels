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

  it('does not turn a bare postcode part into a qualifier', () => {
    expect(qualifiedPlaceName('Placeville', 'Placeville, 84536, USA')).toBe('Placeville');
  });
});
