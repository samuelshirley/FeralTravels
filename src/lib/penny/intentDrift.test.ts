import { describe, expect, it } from 'vitest';
import {
  dropNotice,
  droppedPlaces,
  dropWarning,
  intentPlaceNames,
  mergePlaceNames,
  unmentionedDrops,
} from './intentDrift';

/**
 * No silent drops. The two intents are the real `extract_trip_intent` inputs
 * from trip 9a3df982 (2026-10-08): Picos de Europa is in the first and gone
 * from the second, and Penny never said so.
 */

const FIRST = {
  origin: 'Girona',
  destination: 'Girona',
  mandatory_waypoints: [
    { name: 'Picos de Europa' },
    { name: 'Ordesa y Monte Perdido' },
    { name: 'Aigüestortes i Estany de Sant Maurici' },
    { name: 'Tabernas Desert' },
  ],
};

const SECOND = {
  origin: 'Girona, Spain',
  destination: 'Girona, Spain',
  mandatory_waypoints: [
    { name: 'Ordesa y Monte Perdido (Torla-Ordesa)' },
    { name: 'Aigüestortes i Estany de Sant Maurici' },
    { name: 'Tabernas Desert' },
    { name: 'Gorafe' },
  ],
};

const REPLY =
  'Loop is built: Girona → Pyrenees (Ordesa, then Aigüestortes for autumn colors) → desert warmup (Tabernas, then Gorafe) → home.';

describe('intentPlaceNames', () => {
  it('is the waypoints, without a destination that is just the origin (a loop home)', () => {
    expect(intentPlaceNames(FIRST)).toEqual([
      'Picos de Europa',
      'Ordesa y Monte Perdido',
      'Aigüestortes i Estany de Sant Maurici',
      'Tabernas Desert',
    ]);
  });

  it('includes a real destination', () => {
    expect(
      intentPlaceNames({ origin: 'Austin', destination: 'Zion National Park', mandatory_waypoints: [{ name: 'Big Bend' }] }),
    ).toEqual(['Big Bend', 'Zion National Park']);
  });
});

describe('droppedPlaces', () => {
  it('the incident: Picos de Europa vanished between the two intents', () => {
    expect(droppedPlaces(intentPlaceNames(FIRST), SECOND)).toEqual(['Picos de Europa']);
  });

  it('a re-spelling of the same place is not a drop', () => {
    // "Ordesa y Monte Perdido" → "Ordesa y Monte Perdido (Torla-Ordesa)",
    // "Aigüestortes…" with and without the accent.
    expect(
      droppedPlaces(['Ordesa y Monte Perdido', 'Aiguestortes i Estany de Sant Maurici'], SECOND),
    ).toEqual([]);
  });

  it('a waypoint that became the destination is not a drop', () => {
    expect(
      droppedPlaces(['Moab'], { origin: 'Denver', destination: 'Moab, UT', mandatory_waypoints: [] }),
    ).toEqual([]);
  });

  it('nothing to compare against means nothing dropped', () => {
    expect(droppedPlaces([], SECOND)).toEqual([]);
  });
});

describe('mergePlaceNames', () => {
  it('unions place lists without repeating the same place', () => {
    expect(mergePlaceNames(['Picos de Europa', 'Gorafe'], ['Gorafe, Granada', 'Tabernas'])).toEqual([
      'Picos de Europa',
      'Gorafe',
      'Tabernas',
    ]);
  });
});

describe('the reply check', () => {
  it("the incident's reply never named Picos — so the server must", () => {
    expect(unmentionedDrops(REPLY, ['Picos de Europa'])).toEqual(['Picos de Europa']);
    expect(dropNotice(['Picos de Europa'])).toBe('No longer in the plan: Picos de Europa.');
  });

  it('a reply that names the dropped place is left alone', () => {
    expect(unmentionedDrops(`${REPLY} I left out Picos de Europa — too far west.`, ['Picos de Europa'])).toEqual([]);
  });

  it('the in-tool warning names the place and says to tell the user', () => {
    const w = dropWarning(['Picos de Europa']);
    expect(w).toContain('Picos de Europa');
    expect(w).toMatch(/MUST say so in your reply/);
  });
});
