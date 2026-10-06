import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/db/client', () => ({ db: {} }));
vi.mock('@/server/auth/index', () => ({ auth: vi.fn() }));
vi.mock('@/server/auth/admin', () => ({ isAdminEmail: vi.fn() }));
vi.mock('@/server/payments', () => ({ getAccountVerdict: vi.fn(), maybeAlertThreshold: vi.fn() }));

const m = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  assertTripReadableByUser: vi.fn(),
  assertLegOwnedByUser: vi.fn(),
  addStop: vi.fn(),
  getStopsForLeg: vi.fn(),
  getLegTripId: vi.fn(),
}));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireUserId: m.requireUserId,
  assertTripReadableByUser: m.assertTripReadableByUser,
  assertLegOwnedByUser: m.assertLegOwnedByUser,
}));
vi.mock('@/server/repos/stops', () => ({ addStop: m.addStop, getStopsForLeg: m.getStopsForLeg }));
vi.mock('@/server/repos/tasks', () => ({ getLegTripId: m.getLegTripId }));

import { GET, POST } from './route';
import { ForbiddenError } from '@/server/auth/errors';
import { UUID, jsonRequest } from '@/test/routeHarness';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  m.requireUserId.mockResolvedValue(UUID.owner);
  m.assertLegOwnedByUser.mockResolvedValue(UUID.trip);
  m.addStop.mockImplementation(async (s: unknown) => s);
});

describe('POST /api/stops', () => {
  it("refuses stop_type 'fuel' — fuel rows come only from Finn", async () => {
    const res = await POST(jsonRequest('/api/stops', 'POST', { leg_id: UUID.leg, stop_type: 'fuel', name: 'Repsol' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues[0].path).toBe('stop_type');
    expect(m.addStop).not.toHaveBeenCalled();
  });

  it("adds an 'other' stop on the caller's leg", async () => {
    const res = await POST(jsonRequest('/api/stops', 'POST', { leg_id: UUID.leg, stop_type: 'other', name: 'Bakery' }));
    expect(res.status).toBe(200);
    expect(m.addStop).toHaveBeenCalledWith(expect.objectContaining({ stop_type: 'other', name: 'Bakery' }));
  });

  it("is a 403 on someone else's leg", async () => {
    m.assertLegOwnedByUser.mockRejectedValue(new ForbiddenError());
    const res = await POST(jsonRequest('/api/stops', 'POST', { leg_id: UUID.leg, stop_type: 'other', name: 'x' }));
    expect(res.status).toBe(403);
    expect(m.addStop).not.toHaveBeenCalled();
  });

  it('is a 400 for a malformed body, not a 500', async () => {
    const res = await POST(jsonRequest('/api/stops', 'POST', { leg_id: 'nope', stop_type: 'other', lat: 999 }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/stops', () => {
  it("checks the leg's own trip", async () => {
    m.getLegTripId.mockResolvedValue(UUID.otherTrip);
    m.assertTripReadableByUser.mockRejectedValue(new ForbiddenError());
    const res = await GET(jsonRequest(`/api/stops?legId=${UUID.leg}`, 'GET'));
    expect(res.status).toBe(403);
    expect(m.getStopsForLeg).not.toHaveBeenCalled();
  });
});
