import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/db/client', () => ({ db: {} }));
vi.mock('@/server/auth/index', () => ({ auth: vi.fn() }));
vi.mock('@/server/auth/admin', () => ({ isAdminEmail: vi.fn() }));
vi.mock('@/server/payments', () => ({ getAccountVerdict: vi.fn(), maybeAlertThreshold: vi.fn() }));

const m = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  assertStopOwnedByUser: vi.fn(),
  deleteStop: vi.fn(),
  getStop: vi.fn(),
  updateStop: vi.fn(),
}));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireUserId: m.requireUserId,
  assertStopOwnedByUser: m.assertStopOwnedByUser,
}));
vi.mock('@/server/repos/stops', () => ({ deleteStop: m.deleteStop, getStop: m.getStop, updateStop: m.updateStop }));

import { DELETE, PATCH } from './route';
import { ForbiddenError } from '@/server/auth/errors';
import { UUID, jsonRequest } from '@/test/routeHarness';

const params = { params: { id: UUID.stop } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  m.requireUserId.mockResolvedValue(UUID.owner);
  m.assertStopOwnedByUser.mockResolvedValue(UUID.leg);
  m.updateStop.mockImplementation(async (_id: string, d: unknown) => d);
});

describe('PATCH /api/stops/:id', () => {
  it("refuses turning a stop into stop_type 'fuel'", async () => {
    const res = await PATCH(jsonRequest(`/api/stops/${UUID.stop}`, 'PATCH', { stop_type: 'fuel' }), params);
    expect(res.status).toBe(400);
    expect(m.updateStop).not.toHaveBeenCalled();
  });

  it('still lets the owner dismiss any stop, a Finn fuel stop included (no stop_type sent)', async () => {
    const res = await PATCH(jsonRequest(`/api/stops/${UUID.stop}`, 'PATCH', { status: 'dismissed' }), params);
    expect(res.status).toBe(200);
    expect(m.updateStop).toHaveBeenCalledWith(UUID.stop, { status: 'dismissed' });
  });

  it("is a 403 on someone else's stop, before any write", async () => {
    m.assertStopOwnedByUser.mockRejectedValue(new ForbiddenError());
    const res = await PATCH(jsonRequest(`/api/stops/${UUID.stop}`, 'PATCH', { status: 'dismissed' }), params);
    expect(res.status).toBe(403);
    expect(m.updateStop).not.toHaveBeenCalled();
  });

  it('is a 400 for a bad status, not a 500', async () => {
    const res = await PATCH(jsonRequest(`/api/stops/${UUID.stop}`, 'PATCH', { status: 'gone' }), params);
    expect(res.status).toBe(400);
  });

  it('is a 400 for a malformed id', async () => {
    const res = await PATCH(jsonRequest('/api/stops/x', 'PATCH', {}), { params: { id: 'x' } });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/stops/:id', () => {
  it("is a 403 on someone else's stop", async () => {
    m.assertStopOwnedByUser.mockRejectedValue(new ForbiddenError());
    const res = await DELETE(jsonRequest(`/api/stops/${UUID.stop}`, 'DELETE'), params);
    expect(res.status).toBe(403);
    expect(m.deleteStop).not.toHaveBeenCalled();
  });

  it('deletes the owner stop', async () => {
    m.getStop.mockResolvedValue({ id: UUID.stop });
    const res = await DELETE(jsonRequest(`/api/stops/${UUID.stop}`, 'DELETE'), params);
    expect(res.status).toBe(200);
    expect(m.deleteStop).toHaveBeenCalledWith(UUID.stop);
  });
});
