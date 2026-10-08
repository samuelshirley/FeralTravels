import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { gateStopAction, type StopGateCtx } from './stopGate';
import { attributeStopSource } from './stopAttribution';
import type { ValidatedAction } from '@/lib/penny/tools';

/**
 * The in-loop stop gate: no stop on a place Google types as not drivable, and
 * `source: "user"` only for places the user named. The stops are the four
 * from trip 9a3df982 (2026-10-08), as Penny sent them after "whatever you
 * choose" — every one `source: "user"`.
 */

const SAM_SAID = [
  "I wanna do a national park tour of spain and go to the prettiest places during the leaf peepin areas in the pyrenees",
  "I don't know any besides gorafe and its awesome and I wanna go there too",
  'can you add any offroad routes or gravel roads in there?',
  'yea lets do them all',
];

function ctx(over: Partial<StopGateCtx> = {}): StopGateCtx {
  return {
    context: { legs: [] },
    notDrivablePlaces: [],
    delegated: false,
    userTexts: SAM_SAID,
    pastedPoints: [],
    ...over,
  };
}

function addStop(name: string, lat: number, lng: number, source: 'user' | 'penny' = 'user'): ValidatedAction {
  return {
    name: 'add_stop',
    input: {
      leg_id: '4b759231-2670-4068-a408-8b9aeaf5aeeb',
      data: { stop_type: 'other', name, lat, lng, source, status: 'selected' },
    },
  } as ValidatedAction;
}

const sourceOf = (a: ValidatedAction) => (a.name === 'add_stop' ? a.input.data.source : undefined);

describe('attribution: source "user" only when the user named the place', () => {
  it('the incident: Col du Tourmalet and Gradas de Soaso were never named by the user → "penny"', () => {
    for (const [name, lat, lng] of [
      ['Col du Tourmalet', 42.90815, 0.14525],
      ['Gradas de Soaso, Huesca', 42.63793, -0.00088],
    ] as const) {
      const a = addStop(name, lat, lng);
      const out = gateStopAction(a, ctx());
      expect(out.rejected).toBeNull();
      expect(sourceOf(a)).toBe('penny');
      expect(out.note).toMatch(/source="penny"/);
    }
  });

  it('on a "whatever you choose" turn every pick is "penny" — even one in a place the user mentioned', () => {
    const a = addStop('Desierto de Gorafe los coloraos, Gorafe', 37.5429, -3.04816);
    gateStopAction(a, ctx({ delegated: true }));
    expect(sourceOf(a)).toBe('penny');
  });

  it('a place the user named keeps "user"', () => {
    const a = addStop('Gorafe, Granada', 37.47912, -3.04197);
    const out = gateStopAction(a, ctx());
    expect(sourceOf(a)).toBe('user');
    expect(out.note).toBeNull();
  });

  it('a pasted Maps link that resolved onto the stop keeps "user"', () => {
    const a = addStop('Parcours Sportif de Meythet', 45.917, 6.093);
    gateStopAction(a, ctx({ userTexts: ['go here https://maps.app.goo.gl/abc'], pastedPoints: [{ lat: 45.9171, lng: 6.0931 }] }));
    expect(sourceOf(a)).toBe('user');
  });

  it('a stop Penny already marked "penny" is left alone', () => {
    const a = addStop('Col du Tourmalet', 42.9, 0.14, 'penny');
    expect(gateStopAction(a, ctx()).note).toBeNull();
    expect(sourceOf(a)).toBe('penny');
  });

  it('source_url the user actually pasted keeps "user"', () => {
    expect(
      attributeStopSource({
        source: 'user',
        name: 'Somewhere',
        sourceUrl: 'https://maps.app.goo.gl/xyz',
        delegated: false,
        userTexts: ['add https://maps.app.goo.gl/xyz please'],
        pastedPoints: [],
      }).rewritten,
    ).toBe(false);
  });
});

describe('not-drivable places', () => {
  const circuit = { lat: 37.0851, lng: -2.26672, label: 'Circuito Costa de Almería', reason: 'its name says it is a racing circuit' };

  it('the incident: an add_stop on the racing circuit is refused', () => {
    const out = gateStopAction(addStop('Circuito Costa de Almería', 37.0851, -2.26672), ctx({ notDrivablePlaces: [circuit] }));
    expect(out.rejected).toMatch(/not a drivable waypoint/);
    expect(out.rejected).toMatch(/racing circuit/);
  });

  it('refused by position even under another name, and by name even with drifted coordinates', () => {
    expect(gateStopAction(addStop('Desert loop', 37.0855, -2.2669), ctx({ notDrivablePlaces: [circuit] })).rejected).not.toBeNull();
    expect(gateStopAction(addStop('Circuito Costa de Almería', 37.2, -2.4), ctx({ notDrivablePlaces: [circuit] })).rejected).not.toBeNull();
  });

  it('a stop elsewhere is not affected', () => {
    expect(gateStopAction(addStop('Tabernas', 37.00121, -2.4504), ctx({ notDrivablePlaces: [circuit] })).rejected).toBeNull();
  });

  it('update_stop moving a stop onto a flagged place is refused too', () => {
    const update = {
      name: 'update_stop',
      input: { stop_id: '9b2b6c58-6a4b-4d55-9a3e-6c7f0f1a2b3c', data: { lat: 37.0851, lng: -2.26672 } },
    } as ValidatedAction;
    expect(gateStopAction(update, ctx({ notDrivablePlaces: [circuit] })).rejected).toMatch(/not a drivable waypoint/);
  });
});

describe('everything else passes untouched', () => {
  it('a non-stop action', () => {
    const a = { name: 'delete_stop', input: { stop_id: '9b2b6c58-6a4b-4d55-9a3e-6c7f0f1a2b3c' } } as ValidatedAction;
    expect(gateStopAction(a, ctx())).toEqual({ rejected: null, note: null });
  });
});
