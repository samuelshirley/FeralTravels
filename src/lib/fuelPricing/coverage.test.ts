import { describe, it, expect } from 'vitest';
import { countryHasAnyPriceSource, FEED_COUNTRIES, NO_PRICE_COUNTRIES } from './coverage';

describe('countryHasAnyPriceSource', () => {
  it('feed countries always have a source', () => {
    expect(FEED_COUNTRIES.has('DE')).toBe(true);
    expect(countryHasAnyPriceSource('DE', false)).toBe(true);
  });

  it('no-price countries have none even with a global provider', () => {
    expect(NO_PRICE_COUNTRIES.has('SE')).toBe(true);
    expect(countryHasAnyPriceSource('SE', true)).toBe(false);
    expect(countryHasAnyPriceSource('NO', true)).toBe(false);
  });

  it('unknown / other countries depend on the global provider', () => {
    expect(countryHasAnyPriceSource(null, false)).toBe(false);
    expect(countryHasAnyPriceSource(null, true)).toBe(true);
    expect(countryHasAnyPriceSource('US', false)).toBe(false);
    expect(countryHasAnyPriceSource('US', true)).toBe(true);
  });
});
