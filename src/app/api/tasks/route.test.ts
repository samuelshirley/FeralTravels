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
  assertTripOwnedByUser: vi.fn(),
  assertLegOwnedByUser: vi.fn(),
  getTasksForTrip: vi.fn(),
  getTasksForLeg: vi.fn(),
  addTask: vi.fn(),
  getLegTripId: vi.fn(),
}));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireUserId: m.requireUserId,
  assertTripReadableByUser: m.assertTripReadableByUser,
  assertTripOwnedByUser: m.assertTripOwnedByUser,
  assertLegOwnedByUser: m.assertLegOwnedByUser,
}));
vi.mock('@/server/repos/tasks', () => ({
  getTasksForTrip: m.getTasksForTrip,
  getTasksForLeg: m.getTasksForLeg,
  addTask: m.addTask,
  getLegTripId: m.getLegTripId,
}));

import { GET, POST } from './route';
import { ForbiddenError } from '@/server/auth/errors';
import { UUID, jsonRequest } from '@/test/routeHarness';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  m.requireUserId.mockResolvedValue(UUID.owner);
  m.getTasksForLeg.mockResolvedValue([]);
  m.addTask.mockImplementation(async (t: unknown) => t);
});

describe('GET /api/tasks', () => {
  it("refuses your own tripId paired with someone else's legId", async () => {
    m.getLegTripId.mockResolvedValue(UUID.otherTrip);
    m.assertTripReadableByUser.mockResolvedValue(undefined);
    const res = await GET(jsonRequest(`/api/tasks?tripId=${UUID.trip}&legId=${UUID.leg}`, 'GET'));
    expect(res.status).toBe(404);
    expect(m.getTasksForLeg).not.toHaveBeenCalled();
  });

  it("checks the leg's own trip", async () => {
    m.getLegTripId.mockResolvedValue(UUID.trip);
    m.assertTripReadableByUser.mockResolvedValue(undefined);
    const res = await GET(jsonRequest(`/api/tasks?tripId=${UUID.trip}&legId=${UUID.leg}`, 'GET'));
    expect(res.status).toBe(200);
    expect(m.assertTripReadableByUser).toHaveBeenCalledWith(UUID.trip, UUID.owner);
  });

  it('is a 400 with neither id', async () => {
    expect((await GET(jsonRequest('/api/tasks', 'GET'))).status).toBe(400);
  });
});

describe('POST /api/tasks', () => {
  it('refuses a leg from a different trip than the one named', async () => {
    m.assertTripOwnedByUser.mockResolvedValue(undefined);
    m.assertLegOwnedByUser.mockResolvedValue(UUID.otherTrip);
    const res = await POST(jsonRequest('/api/tasks', 'POST', { trip_id: UUID.trip, leg_id: UUID.leg, title: 'Book ferry' }));
    expect(res.status).toBe(404);
    expect(m.addTask).not.toHaveBeenCalled();
  });

  it("is a 403 on someone else's leg", async () => {
    m.assertTripOwnedByUser.mockResolvedValue(undefined);
    m.assertLegOwnedByUser.mockRejectedValue(new ForbiddenError());
    const res = await POST(jsonRequest('/api/tasks', 'POST', { trip_id: UUID.trip, leg_id: UUID.leg, title: 'x' }));
    expect(res.status).toBe(403);
    expect(m.addTask).not.toHaveBeenCalled();
  });

  it('is a 400 for an empty title, not a 500', async () => {
    const res = await POST(jsonRequest('/api/tasks', 'POST', { trip_id: UUID.trip, title: '' }));
    expect(res.status).toBe(400);
  });

  it('creates the task on a matching trip and leg', async () => {
    m.assertTripOwnedByUser.mockResolvedValue(undefined);
    m.assertLegOwnedByUser.mockResolvedValue(UUID.trip);
    const res = await POST(jsonRequest('/api/tasks', 'POST', { trip_id: UUID.trip, leg_id: UUID.leg, title: 'Book ferry' }));
    expect(res.status).toBe(200);
    expect(m.addTask).toHaveBeenCalledWith(expect.objectContaining({ trip_id: UUID.trip, leg_id: UUID.leg, title: 'Book ferry' }));
  });
});
