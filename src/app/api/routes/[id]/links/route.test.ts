import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/db/client', () => ({ db: {} }));
vi.mock('@/server/auth/index', () => ({ auth: vi.fn() }));
vi.mock('@/server/auth/admin', () => ({ isAdminEmail: vi.fn() }));
vi.mock('@/server/payments', () => ({ getAccountVerdict: vi.fn(), maybeAlertThreshold: vi.fn() }));

const m = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  assertRouteOwnedByUser: vi.fn(),
  addRouteLink: vi.fn(),
  deleteRouteLink: vi.fn(),
  getRoute: vi.fn(),
}));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireUserId: m.requireUserId,
  assertRouteOwnedByUser: m.assertRouteOwnedByUser,
}));
vi.mock('@/server/repos/routes', () => ({
  addRouteLink: m.addRouteLink,
  deleteRouteLink: m.deleteRouteLink,
  getRoute: m.getRoute,
}));

import { DELETE, POST } from './route';
import { ForbiddenError, UnauthorizedError } from '@/server/auth/errors';
import { UUID, jsonRequest } from '@/test/routeHarness';

const params = { params: { id: UUID.route } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  m.requireUserId.mockResolvedValue(UUID.owner);
  m.assertRouteOwnedByUser.mockResolvedValue(UUID.leg);
  m.getRoute.mockResolvedValue({ id: UUID.route });
});

describe('DELETE /api/routes/:id/links', () => {
  it('deletes the link only within the route the caller owns (the IDOR fix)', async () => {
    m.deleteRouteLink.mockResolvedValue(true);
    const res = await DELETE(jsonRequest(`/api/routes/${UUID.route}/links?linkId=${UUID.link}`, 'DELETE'), params);
    expect(res.status).toBe(200);
    expect(m.deleteRouteLink).toHaveBeenCalledWith(UUID.route, UUID.link);
  });

  it("is a 404 when the link is not on the caller's route — someone else's link survives", async () => {
    m.deleteRouteLink.mockResolvedValue(false);
    const res = await DELETE(jsonRequest(`/api/routes/${UUID.route}/links?linkId=${UUID.link}`, 'DELETE'), params);
    expect(res.status).toBe(404);
  });

  it("is a 403 on a route the caller does not own, before any delete", async () => {
    m.assertRouteOwnedByUser.mockRejectedValue(new ForbiddenError());
    const res = await DELETE(jsonRequest(`/api/routes/${UUID.route}/links?linkId=${UUID.link}`, 'DELETE'), params);
    expect(res.status).toBe(403);
    expect(m.deleteRouteLink).not.toHaveBeenCalled();
  });

  it('is a 400 for a missing or malformed linkId', async () => {
    expect((await DELETE(jsonRequest(`/api/routes/${UUID.route}/links`, 'DELETE'), params)).status).toBe(400);
    expect((await DELETE(jsonRequest(`/api/routes/${UUID.route}/links?linkId=nope`, 'DELETE'), params)).status).toBe(400);
  });
});

describe('POST /api/routes/:id/links', () => {
  it('is a 400 for a body missing its url, not a 500', async () => {
    const res = await POST(jsonRequest(`/api/routes/${UUID.route}/links`, 'POST', { label: 'x' }), params);
    expect(res.status).toBe(400);
    expect(m.addRouteLink).not.toHaveBeenCalled();
  });

  it('is a 401 signed out', async () => {
    m.requireUserId.mockRejectedValue(new UnauthorizedError());
    const res = await POST(jsonRequest(`/api/routes/${UUID.route}/links`, 'POST', { url: 'https://a.b' }), params);
    expect(res.status).toBe(401);
  });

  it('adds the link to the owned route', async () => {
    m.addRouteLink.mockResolvedValue({ id: UUID.link });
    const res = await POST(
      jsonRequest(`/api/routes/${UUID.route}/links`, 'POST', { url: 'https://a.b', type: 'gaia' }),
      params,
    );
    expect(res.status).toBe(200);
    expect(m.addRouteLink).toHaveBeenCalledWith({
      route_id: UUID.route,
      url: 'https://a.b',
      label: 'gaia',
      type: 'gaia',
    });
  });
});
