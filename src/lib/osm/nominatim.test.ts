import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import fixtures from './__fixtures__/nominatim-reverse.json';

const { formatPlaceLabel, settlementRank, rankAtLeast, reverseUrl } = await import('./nominatim');

/**
 * EVERY PAYLOAD HERE WAS CAPTURED FROM LIVE NOMINATIM (2026-09-22,
 * `scripts/capture-nominatim-fixtures.mjs`). That is the point of the file.
 *
 * The version of these tests this replaces asserted against
 * `{ city: 'Girona', country: 'Spain' }` — a shape Nominatim never returns for
 * Girona. It returns `state: 'Catalunya', country: 'España'`, so the test that
 * was meant to prove the non-US path passed while the non-US path was broken,
 * and shipped "Tavel, Occitania" to a real itinerary (2026-09-21). An invented
 * payload tests the function against the author's memory of the API.
 */
const points = fixtures.points as Record<
  string,
  { name: string | null; address: Record<string, string> }
>;
const label = (key: string) => {
  const p = points[key];
  if (!p) throw new Error(`no fixture: ${key}`);
  return formatPlaceLabel(p.name, p.address);
};

describe('formatPlaceLabel — qualifier', () => {
  it('uses the state where the state is what people say', () => {
    expect(label('amarillo_us_city')).toBe('Amarillo, Texas');
    expect(label('marfa_us_town')).toBe('Marfa, Texas');
  });

  it('uses the country everywhere else — a French region is not a qualifier', () => {
    // The reported bug, verbatim: `address.state` here is "Occitania", so the
    // old `state ?? country` rule rendered "Tavel, Occitania".
    expect(points.tavel_fr_village.address.state).toBe('Occitania');
    expect(label('tavel_fr_village')).toBe('Tavel, France');

    expect(points.annecy_fr_city.address.state).toBe('Auvergne-Rhône-Alpes');
    expect(label('annecy_fr_city')).toBe('Annecy, France');

    expect(label('girona_es_city')).toBe('Girona, Spain');
    expect(label('modena_it_city')).toBe('Modena, Italy');
    expect(label('dortmund_de_city')).toBe('Dortmund, Germany');
  });

  it('falls back to the country when a state-qualifier country has no state', () => {
    // Norway has no `state` at all in Nominatim's answer.
    expect(points.bergen_no_city.address.state).toBeUndefined();
    expect(label('bergen_no_city')).toBe('Bergen, Norway');
  });

  it('does not repeat itself when locality and qualifier are the same', () => {
    expect(label('singapore_sg')).toBe('Singapore');
  });
});

describe('formatPlaceLabel — locality', () => {
  it('uses the top-level name when the address has no locality', () => {
    expect(label('monument_valley_us_remote')).toBe('Navajo County, Arizona');
  });

  it('returns null rather than a made-up name when there is nothing usable', () => {
    // A point in the Atlantic. The caller must degrade, not invent.
    expect(label('atlantic_ocean')).toBeNull();
    expect(formatPlaceLabel(null, {})).toBeNull();
    expect(formatPlaceLabel(null, null)).toBeNull();
    expect(formatPlaceLabel(undefined, undefined)).toBeNull();
  });

  it('never returns a bare region word', () => {
    expect(formatPlaceLabel(null, { state: 'Texas', country: 'United States' })).toBeNull();
  });
});

describe('accept-language', () => {
  /**
   * Not a test of our code — a test of the CLAIM our code is built on, so that
   * dropping `accept-language` from the request URL cannot silently go
   * unnoticed. Both fixtures are the same coordinate, one with the parameter
   * and one without.
   */
  it('is on the request we actually send, alongside addressdetails', () => {
    const url = reverseUrl(41.9794, 2.8214);
    expect(url).toContain('accept-language=en');
    expect(url).toContain('addressdetails=1');
    expect(url).toContain('zoom=10');
  });

  it('is what stops Nominatim answering in the local language', () => {
    expect(points.girona_es_no_accept_language.address.country).toBe('España');
    expect(points.girona_es_city.address.country).toBe('Spain');
    expect(points.modena_it_no_accept_language.address.country).toBe('Italia');
    expect(points.modena_it_city.address.country).toBe('Italy');
  });
});

describe('settlementRank', () => {
  it('reads the rank off the key Nominatim used', () => {
    expect(settlementRank(points.annecy_fr_city.address)).toBe('city');
    expect(settlementRank(points.orange_fr_town.address)).toBe('town');
    expect(settlementRank(points.tavel_fr_village.address)).toBe('village');
    expect(settlementRank(points.monument_valley_us_remote.address)).toBe('none');
    expect(settlementRank(points.atlantic_ocean.address)).toBe('none');
    expect(settlementRank(null)).toBe('none');
  });

  it('orders city > town > village > hamlet > none', () => {
    expect(rankAtLeast('city', 'town')).toBe(true);
    expect(rankAtLeast('town', 'town')).toBe(true);
    expect(rankAtLeast('village', 'town')).toBe(false);
    expect(rankAtLeast('none', 'hamlet')).toBe(false);
  });
});
