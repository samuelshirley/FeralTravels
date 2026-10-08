import { describe, expect, it } from 'vitest';
import { findSurfaceClaim, notDrivableReason, NOT_DRIVABLE_PLACE_TYPES } from './unsourcedFacts';

/**
 * Facts Penny has no source for. The notes and places below are the real ones
 * from trip 9a3df982 (2026-10-08).
 */

describe('findSurfaceClaim', () => {
  it.each([
    ['Iconic high pass — mixed surface, great views', 'mixed surface'],
    ['Gravel loop through the desert landscape', 'Gravel'],
    ['Badlands plateau with wash crossings and rough terrain', 'wash crossings'],
    ['rough terrain all the way', 'rough terrain'],
    ['high-clearance vehicles only', 'high-clearance'],
    ['Great off-road section', 'off-road'],
    ['offroad fun', 'offroad'],
    ['4x4 only', '4x4'],
    ['fully paved climb', 'paved'],
    ['dirt track to the viewpoint', 'dirt'],
    ['Pista forestal', 'Pista'],
  ])('"%s" claims a surface ("%s")', (text, phrase) => {
    expect(findSurfaceClaim(text)).toBe(phrase);
  });

  it.each([
    'Waterfall and canyon trail — stunning hike from Ordesa base',
    'Visitor centre for the national park',
    'Megalithic park with dolmens',
    '',
    null,
    undefined,
  ])('"%s" claims nothing', (text) => {
    expect(findSurfaceClaim(text)).toBeNull();
  });
});

describe('notDrivableReason', () => {
  it('uses only type strings Places (New) actually has (Table A, checked 2026-10-08)', () => {
    expect(Object.keys(NOT_DRIVABLE_PLACE_TYPES).sort()).toEqual(
      ['go_karting_venue', 'hiking_area', 'race_course'],
    );
  });

  it('a primary type of race course, karting venue or hiking area is not drivable', () => {
    expect(notDrivableReason({ primaryType: 'race_course', name: 'X' })).toMatch(/race course/);
    expect(notDrivableReason({ primaryType: 'go_karting_venue', name: 'X' })).toMatch(/karting/);
    expect(notDrivableReason({ primaryType: 'hiking_area', name: 'Gradas de Soaso' })).toMatch(/hiking area/);
  });

  it('race_course anywhere in types is enough', () => {
    expect(
      notDrivableReason({ primaryType: 'tourist_attraction', types: ['tourist_attraction', 'race_course'], name: 'X' }),
    ).toMatch(/race course/);
  });

  it('a national park that merely LISTS hiking_area is still a destination', () => {
    expect(
      notDrivableReason({
        primaryType: 'national_park',
        types: ['national_park', 'park', 'hiking_area', 'tourist_attraction'],
        name: 'Ordesa y Monte Perdido National Park',
      }),
    ).toBeNull();
    expect(
      notDrivableReason({ types: ['park', 'hiking_area'], name: 'Some park' }),
    ).toBeNull();
  });

  it('hiking_area with no primary type and nothing park-like is flagged', () => {
    expect(notDrivableReason({ types: ['hiking_area', 'point_of_interest'], name: 'A trail' })).toMatch(/hiking area/);
  });

  it('a racing circuit is caught by name when Google types it as something generic', () => {
    expect(
      notDrivableReason({ types: ['point_of_interest', 'establishment'], name: 'Circuito Costa de Almería' }),
    ).toMatch(/racing circuit/);
    expect(notDrivableReason({ name: 'Laguna Seca Raceway' })).toMatch(/racing circuit/);
  });

  it('ordinary places are fine', () => {
    expect(notDrivableReason({ primaryType: 'locality', types: ['locality', 'political'], name: 'Tabernas' })).toBeNull();
    expect(notDrivableReason({ name: 'Col du Tourmalet' })).toBeNull();
    expect(notDrivableReason({ types: null, name: 'Gorafe' })).toBeNull();
  });
});
