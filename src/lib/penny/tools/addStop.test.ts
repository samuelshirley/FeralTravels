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
