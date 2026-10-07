import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * applyAddStop end to end with the database stubbed: which leg a Penny stop is
 * written to. The rest-day rule itself is unit-tested in
 * src/lib/penny/newLegFallback.test.ts; here, that the write path uses it for
 * stops, reads the trip only when it might apply, and keeps the invented-id
 * fallback working.
 */
const m = vi.hoisted(() => ({
  assertLegOwnedByUser: vi.fn(),
  addStop: vi.fn(),
  getTripFull: vi.fn(),
}));
vi.mock('@/server/auth/guards', async () => {
  const errors = await import('@/server/auth/errors');
  return {
    assertLegOwnedByUser: m.assertLegOwnedByUser,
    ForbiddenError: errors.ForbiddenError,
    NotFoundError: errors.NotFoundError,
  };
});
vi.mock('@/server/repos/stops', () => ({ addStop: m.addStop }));
vi.mock('@/server/repos/trips', () => ({ getTripFull: m.getTripFull }));

import { applyAddStop, type ReplanDispatchCtx } from './pennyAddStop';
import { NotFoundError } from '@/server/auth/errors';
import type { AddStopInput } from '@/lib/penny/tools/addStop';

const TRIP = 'trip-1';
const USER = 'user-1';
const STRASBOURG = { lat: 48.5734, lng: 7.7521 };
const CATHEDRAL = { lat: 48.5818, lng: 7.7509 };
const DAY2 = 'existing-day-2';
const NEW_REST = 'new-base-day';

const tripLegs = [
  { id: 'existing-day-1', start_lat: 48.8566, start_lng: 2.3522, end_lat: STRASBOURG.lat, end_lng: STRASBOURG.lng },
  { id: DAY2, start_lat: STRASBOURG.lat, start_lng: STRASBOURG.lng, end_lat: 48.7758, end_lng: 9.1829 },
];

function stop(legId: string, at: { lat: number; lng: number }): AddStopInput {
  return {
    leg_id: legId,
    data: { stop_type: 'other', name: 'Strasbourg Cathedral', lat: at.lat, lng: at.lng },
  } as AddStopInput;
}

function ctxWith(newLegs: ReplanDispatchCtx['newLegs']): ReplanDispatchCtx {
  return { newLegIdsQueue: newLegs.map((l) => l.id), newLegs };
}

const restDay = {
  id: NEW_REST,
  startLat: STRASBOURG.lat,
  startLng: STRASBOURG.lng,
  endLat: STRASBOURG.lat,
  endLng: STRASBOURG.lng,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.assertLegOwnedByUser.mockResolvedValue(TRIP);
  m.addStop.mockImplementation(async (s: { leg_id: string }) => ({ id: 'stop-1', ...s }));
  m.getTripFull.mockResolvedValue({ id: TRIP, legs: tripLegs });
});

describe('applyAddStop: the leg a Penny stop is written to', () => {
  it('(a) the 2026-10-07 case: the cathedral lands on this turn\'s new base day, not day 2', async () => {
    await applyAddStop(stop(DAY2, CATHEDRAL), TRIP, USER, ctxWith([restDay]));
    expect(m.addStop).toHaveBeenCalledWith(expect.objectContaining({ leg_id: NEW_REST }));
  });

  it('(b) no rest day this turn: the named real leg, and no trip read', async () => {
    await applyAddStop(stop(DAY2, CATHEDRAL), TRIP, USER, ctxWith([]));
    expect(m.addStop).toHaveBeenCalledWith(expect.objectContaining({ leg_id: DAY2 }));
    expect(m.getTripFull).not.toHaveBeenCalled();
  });

  it('(d) a stop far down the onward road stays on day 2, without a trip read', async () => {
    await applyAddStop(stop(DAY2, { lat: 48.8922, lng: 8.6946 }), TRIP, USER, ctxWith([restDay]));
    expect(m.addStop).toHaveBeenCalledWith(expect.objectContaining({ leg_id: DAY2 }));
    expect(m.getTripFull).not.toHaveBeenCalled();
  });

  it('(e) an INVENTED leg id still falls back to the nearest leg created this turn', async () => {
    m.assertLegOwnedByUser.mockRejectedValue(new NotFoundError('Leg not found'));
    const newDrive = { id: 'new-drive', startLat: 48.8566, startLng: 2.3522, endLat: 49.2583, endLng: 4.0317 };
    await applyAddStop(stop('invented-id', { lat: 49.0, lng: 3.0 }), TRIP, USER, ctxWith([newDrive]));
    expect(m.addStop).toHaveBeenCalledWith(expect.objectContaining({ leg_id: 'new-drive' }));
  });

  it('a genuinely bogus id with nothing created this turn is still refused', async () => {
    m.assertLegOwnedByUser.mockRejectedValue(new NotFoundError('Leg not found'));
    await expect(applyAddStop(stop('bogus', CATHEDRAL), TRIP, USER, ctxWith([]))).rejects.toBeInstanceOf(NotFoundError);
    expect(m.addStop).not.toHaveBeenCalled();
  });
});
