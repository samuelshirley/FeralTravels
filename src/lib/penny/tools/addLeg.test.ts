/**
 * Tests for the add_leg tool definition + validator. Focus: the cross-field
 * refines — rest legs must carry names + coords (silent-corruption guard), and
 * drive legs must respect the vehicle's daily drive cap.
 */
import { describe, it, expect, vi } from 'vitest';

// `server-only` throws under the jsdom test env; stub it (hoisted above imports).
vi.mock('server-only', () => ({}));

import { ADD_LEG, tool, validator } from './addLeg';
import type { PennyContext } from '@/lib/penny/context';

const noVehicleCtx = {} as PennyContext;
const cappedCtx = {
  vehicle: { transit_max_drive_hours: 8 },
} as unknown as PennyContext;

const restLegAtLocation = {
  title: 'Glacier (rest day)',
  leg_type: 'rest' as const,
  start_name: 'Glacier NP',
  end_name: 'Glacier NP',
  start_lat: 48.6968,
  start_lng: -113.718,
  end_lat: 48.6968,
  end_lng: -113.718,
};

describe('add_leg tool', () => {
  it('has a stable name matching the Anthropic tool def', () => {
    expect(ADD_LEG).toBe('add_leg');
    expect(tool.name).toBe(ADD_LEG);
    expect(tool.input_schema.required).toEqual(['title']);
  });

  describe('rest-leg validation', () => {
    it('rejects a rest leg with no coordinates or names', () => {
      // This is the exact malformed shape Penny emitted on Summer '26.
      const parsed = validator(noVehicleCtx).safeParse({
        title: 'Glacier (rest day)',
        leg_type: 'rest',
        constraints: [],
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const msg = parsed.error.issues[0].message;
        expect(msg).toMatch(/rest legs require start_name, end_name, and start\/end coordinates/);
        expect(parsed.error.issues[0].path).toEqual(['start_name']);
      }
    });

    it('rejects a rest leg with names but missing coordinates', () => {
      const parsed = validator(noVehicleCtx).safeParse({
        title: 'Glacier (rest day)',
        leg_type: 'rest',
        start_name: 'Glacier NP',
        end_name: 'Glacier NP',
      });
      expect(parsed.success).toBe(false);
    });

    it('accepts a rest leg with names + start/end coordinates', () => {
      const parsed = validator(noVehicleCtx).safeParse(restLegAtLocation);
      expect(parsed.success).toBe(true);
    });
  });

  describe('drive-leg validation', () => {
    it('accepts a drive leg within the vehicle drive cap', () => {
      const parsed = validator(cappedCtx).safeParse({
        title: 'Girona → Lyon',
        leg_type: 'drive',
        start_name: 'Girona',
        end_name: 'Lyon',
        drive_time_minutes: 7 * 60,
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects a drive leg exceeding the vehicle drive cap', () => {
      const parsed = validator(cappedCtx).safeParse({
        title: 'Girona → Berlin',
        leg_type: 'drive',
        start_name: 'Girona',
        end_name: 'Berlin',
        drive_time_minutes: 21 * 60,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0].path).toEqual(['drive_time_minutes']);
      }
    });

    it('does not require coordinates on drive legs (only rest legs)', () => {
      const parsed = validator(noVehicleCtx).safeParse({
        title: 'Girona → Lyon',
        leg_type: 'drive',
      });
      expect(parsed.success).toBe(true);
    });
  });
});
