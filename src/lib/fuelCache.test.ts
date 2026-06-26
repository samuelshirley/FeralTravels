import { describe, it, expect } from 'vitest';
import { FUEL_CACHE_TTL_MS, isFuelCacheFresh } from './fuelCache';

describe('fuel cache freshness', () => {
  const now = Date.parse('2026-06-26T12:00:00.000Z');

  it('treats a null/empty timestamp as not fresh (re-check on open)', () => {
    expect(isFuelCacheFresh(null, now)).toBe(false);
    expect(isFuelCacheFresh(undefined, now)).toBe(false);
    expect(isFuelCacheFresh('', now)).toBe(false);
  });

  it('treats an unparseable timestamp as not fresh', () => {
    expect(isFuelCacheFresh('not-a-date', now)).toBe(false);
  });

  it('is fresh just inside the TTL window', () => {
    const justInside = new Date(now - (FUEL_CACHE_TTL_MS - 1_000)).toISOString();
    expect(isFuelCacheFresh(justInside, now)).toBe(true);
  });

  it('is stale just past the TTL window', () => {
    const justPast = new Date(now - (FUEL_CACHE_TTL_MS + 1_000)).toISOString();
    expect(isFuelCacheFresh(justPast, now)).toBe(false);
  });

  it('a brand-new timestamp is fresh', () => {
    expect(isFuelCacheFresh(new Date(now).toISOString(), now)).toBe(true);
  });

  it('uses a 48h window', () => {
    expect(FUEL_CACHE_TTL_MS).toBe(48 * 60 * 60 * 1000);
  });
});
