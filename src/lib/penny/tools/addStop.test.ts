/**
 * Tests for the add_stop tool validator.
 *
 * The load-bearing invariant: Penny can ONLY author 'other' stops here. Fuel
 * stops come exclusively from Finn (plan_fuel_stops) / the server-side lazy
 * loader, which attach a real located station. A hand-typed fuel stop would be
 * a coordinate-less placeholder pointing at no actual station — exactly the
 * "empty stop that does nothing" bug. The schema must make that unreachable.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator } from './addStop';
import type { PennyContext } from '@/lib/penny/context';

// The add_stop validator only reads ctx.legs; a corridor/distance leg isn't
// needed for these type-level assertions, so an empty legs array is enough.
const ctx = { legs: [] } as unknown as PennyContext;

const LEG_ID = '00000000-0000-0000-0000-000000000001';

describe('add_stop validator', () => {
  it('rejects stop_type "fuel" — Penny may not author fuel stops', () => {
    const result = validator(ctx).safeParse({
      leg_id: LEG_ID,
      data: { stop_type: 'fuel', name: 'Fuel stop — Aurdal (departure)' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts stop_type "other" (a user-named place)', () => {
    const result = validator(ctx).safeParse({
      leg_id: LEG_ID,
      data: {
        stop_type: 'other',
        name: 'Trollstigen viewpoint',
        lat: 62.456,
        lng: 7.671,
        status: 'selected',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('add_stop duplicate-destination guard', () => {
  // Real geometry from the trip d0b5741b incident: Penny added the leg's
  // destination (Rutviksvägen 40, Gammelstad) as an 'other' stop at exactly
  // the leg-end coords, duplicating the automatic "Route to Destination"
  // nav button. The validator must reject stops within ~1 km of the leg end.
  const legCtx = {
    legs: [
      {
        id: LEG_ID,
        title: 'Puoltikasvaara → Rutviksvägen 40, Gammelstad',
        distance_km: 269.6,
        start_lat: 67.479858,
        start_lng: 21.11667,
        end_lat: 65.64777,
        end_lng: 22.02833,
      },
    ],
  } as unknown as PennyContext;

  it('rejects a stop at exactly the leg-end coords (the prod incident)', () => {
    const result = validator(legCtx).safeParse({
      leg_id: LEG_ID,
      data: {
        stop_type: 'other',
        name: 'Rutviksvägen 40, Gammelstad',
        lat: 65.64777,
        lng: 22.02833,
        distance_from_start_km: 269.6,
        status: 'selected',
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toMatch(/Route to Destination/);
      expect(msg).toMatch(/app_ui_awareness/);
    }
  });

  it('rejects a stop a few hundred metres from the leg end', () => {
    const result = validator(legCtx).safeParse({
      leg_id: LEG_ID,
      data: { stop_type: 'other', name: 'Gammelstad church', lat: 65.6455, lng: 22.027 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a stop safely along the route (>1 km from the end)', () => {
    const result = validator(legCtx).safeParse({
      leg_id: LEG_ID,
      data: {
        stop_type: 'other',
        name: 'Överkalix bakery',
        lat: 66.3,
        lng: 22.8,
        distance_from_start_km: 180,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a stop near the leg START (errand before leaving town is legit)', () => {
    const result = validator(legCtx).safeParse({
      leg_id: LEG_ID,
      data: { stop_type: 'other', name: 'Puoltikasvaara kiosk', lat: 67.4797, lng: 21.1165, distance_from_start_km: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('skips the guard when the leg has no end coords', () => {
    const noCoordsCtx = {
      legs: [{ id: LEG_ID, title: 'T', end_lat: null, end_lng: null }],
    } as unknown as PennyContext;
    const result = validator(noCoordsCtx).safeParse({
      leg_id: LEG_ID,
      data: { stop_type: 'other', name: 'Somewhere', lat: 65.64777, lng: 22.02833 },
    });
    expect(result.success).toBe(true);
  });
});
