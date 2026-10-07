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
  getRoutesForLeg: vi.fn(),
  addRoute: vi.fn(),
  getLegTripId: vi.fn(),
}));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireUserId: m.requireUserId,
  assertTripReadableByUser: m.assertTripReadableByUser,
  assertLegOwnedByUser: m.assertLegOwnedByUser,
}));
vi.mock('@/server/repos/routes', () => ({ getRoutesForLeg: m.getRoutesForLeg, addRoute: m.addRoute }));
vi.mock('@/server/repos/tasks', () => ({ getLegTripId: m.getLegTripId }));

import { GET, POST } from './route';
import { ForbiddenError } from '@/server/auth/errors';
import { UUID, jsonRequest } from '@/test/routeHarness';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  m.requireUserId.mockResolvedValue(UUID.owner);
  m.getRoutesForLeg.mockResolvedValue([]);
});

describe('GET /api/routes', () => {
  it("refuses your own tripId paired with someone else's legId (the cross-tenant read)", async () => {
    // The leg belongs to otherTrip; the caller can read UUID.trip (their own).
    m.getLegTripId.mockResolvedValue(UUID.otherTrip);
    m.assertTripReadableByUser.mockImplementation(async (tripId: string) => {
      if (tripId !== UUID.trip) throw new ForbiddenError();
    });
    const res = await GET(jsonRequest(`/api/routes?tripId=${UUID.trip}&legId=${UUID.leg}`, 'GET'));
    expect(res.status).toBe(404);
    expect(m.getRoutesForLeg).not.toHaveBeenCalled();
  });

  it("checks the leg's own trip when no tripId is given", async () => {
    m.getLegTripId.mockResolvedValue(UUID.otherTrip);
    m.assertTripReadableByUser.mockRejectedValue(new ForbiddenError());
    const res = await GET(jsonRequest(`/api/routes?legId=${UUID.leg}`, 'GET'));
    expect(res.status).toBe(403);
    expect(m.getRoutesForLeg).not.toHaveBeenCalled();
  });

  it('reads the leg when tripId matches the leg', async () => {
    m.getLegTripId.mockResolvedValue(UUID.trip);
    m.assertTripReadableByUser.mockResolvedValue(undefined);
    const res = await GET(jsonRequest(`/api/routes?tripId=${UUID.trip}&legId=${UUID.leg}`, 'GET'));
    expect(res.status).toBe(200);
    expect(m.assertTripReadableByUser).toHaveBeenCalledWith(UUID.trip, UUID.owner);
    expect(m.getRoutesForLeg).toHaveBeenCalledWith(UUID.leg);
  });

  it('is a 400 without a valid legId', async () => {
    expect((await GET(jsonRequest('/api/routes', 'GET'))).status).toBe(400);
    expect((await GET(jsonRequest('/api/routes?legId=x', 'GET'))).status).toBe(400);
  });
});

describe('POST /api/routes', () => {
  it('is a 400 naming the bad field, not a 500', async () => {
    const res = await POST(jsonRequest('/api/routes', 'POST', { leg_id: UUID.leg, label: '', end_lat: 200 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues.map((i) => i.path).sort()).toEqual(['end_lat', 'label']);
    expect(m.addRoute).not.toHaveBeenCalled();
  });

  it("is a 403 on someone else's leg", async () => {
    m.assertLegOwnedByUser.mockRejectedValue(new ForbiddenError());
    const res = await POST(jsonRequest('/api/routes', 'POST', { leg_id: UUID.leg, label: 'Coast road' }));
    expect(res.status).toBe(403);
    expect(m.addRoute).not.toHaveBeenCalled();
  });
});
