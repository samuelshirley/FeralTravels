/**
 * Tests for the update_leg tool validator.
 *
 * The load-bearing invariant: Penny may NOT redefine a REST leg's location or
 * route metrics. rebuildTripSchedule re-materializes every rest day as "stay at
 * the previous drive's end", so such an edit is silently reverted seconds after
 * it lands while Penny's prose claims it saved — the "campsite near Alset" bug
 * (prod, 2026-07-02): a Trondheim rest day was update_leg'd into a pseudo-drive
 * to a campsite, the rebuild put it back in Trondheim, and the user was told
 * the campsite was saved. The validator must make that unreachable in-loop so
 * Penny self-corrects within the turn.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, restLegBlockedFields } from './updateLeg';
import type { PennyContext } from '@/lib/penny/context';

const REST_LEG_ID = '00000000-0000-0000-0000-00000000000a';
const DRIVE_LEG_ID = '00000000-0000-0000-0000-00000000000b';

const ctx = {
  legs: [
    { id: REST_LEG_ID, leg_type: 'rest' },
    { id: DRIVE_LEG_ID, leg_type: 'drive' },
  ],
} as unknown as PennyContext;

describe('update_leg validator — rest-leg guard', () => {
  it('rejects a location edit on a rest leg (the campsite-repurposing bug)', () => {
    const result = validator(ctx).safeParse({
      leg_id: REST_LEG_ID,
      data: {
        title: 'Trondheim → Campsite (Alset area)',
        end_name: 'Campsite, Alset, Norway',
        end_lat: 63.6989632,
        end_lng: 10.4189239,
        distance_km: 53.1,
        drive_time_minutes: 88,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toMatch(/rest day/i);
      expect(msg).toMatch(/add_stop|drive leg/i);
    }
  });

  it('rejects even a single blocked field (distance_km) on a rest leg', () => {
    const result = validator(ctx).safeParse({
      leg_id: REST_LEG_ID,
      data: { distance_km: 10 },
    });
    expect(result.success).toBe(false);
  });

  it('allows non-route edits (notes, status, color, costs) on a rest leg', () => {
    const result = validator(ctx).safeParse({
      leg_id: REST_LEG_ID,
      data: {
        notes: ['Laundry day'],
        status: 'confirmed',
        color: '#aabbcc',
        costs: [{ item: 'campsite fee', estimate: '250 NOK' }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('allows the same location edit on a DRIVE leg', () => {
    const result = validator(ctx).safeParse({
      leg_id: DRIVE_LEG_ID,
      data: {
        end_name: 'Campsite, Alset, Norway',
        end_lat: 63.6989632,
        end_lng: 10.4189239,
        distance_km: 53.1,
        drive_time_minutes: 88,
      },
    });
    expect(result.success).toBe(true);
  });

  it('skips the guard for a leg not in context (apply-time guard covers it)', () => {
    const result = validator(ctx).safeParse({
      leg_id: '00000000-0000-0000-0000-0000000000ff',
      data: { end_name: 'Somewhere', end_lat: 60, end_lng: 10 },
    });
    expect(result.success).toBe(true);
  });

  it('still enforces the drive-time cap', () => {
    const result = validator(ctx).safeParse({
      leg_id: DRIVE_LEG_ID,
      data: { drive_time_minutes: 20 * 60 },
    });
    expect(result.success).toBe(false);
  });
});

describe('restLegBlockedFields', () => {
  it('lists only the touched blocked fields', () => {
    expect(restLegBlockedFields({ end_lat: 1, notes: ['x'] })).toEqual(['end_lat']);
    expect(restLegBlockedFields({ notes: ['x'], status: 'confirmed' })).toEqual([]);
  });
});
