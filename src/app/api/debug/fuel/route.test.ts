import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/db/client', () => ({ db: {} }));
vi.mock('@/server/payments', () => ({ getAccountVerdict: vi.fn(), maybeAlertThreshold: vi.fn() }));

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  isAdminEmail: vi.fn(),
  getDirectionsAccounted: vi.fn(),
  searchFuelAlongRouteAccounted: vi.fn(),
  getDefaultVehicleForUser: vi.fn(),
}));
vi.mock('@/server/auth/index', () => ({ auth: m.auth }));
vi.mock('@/server/auth/admin', () => ({ isAdminEmail: m.isAdminEmail }));
vi.mock('@/server/google/accounted', () => ({
  getDirectionsAccounted: m.getDirectionsAccounted,
  searchFuelAlongRouteAccounted: m.searchFuelAlongRouteAccounted,
}));
vi.mock('@/server/repos/vehicles', () => ({ getDefaultVehicleForUser: m.getDefaultVehicleForUser }));

import { GET } from './route';
import { SessionStoreUnavailableError } from '@/server/auth/errors';

/**
 * Every hit is two PAID Google calls, so the refusals must happen before
 * either — and must carry their real status, not the blanket 500 this used to
 * return for everything.
 */
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getDefaultVehicleForUser.mockResolvedValue(null);
  m.getDirectionsAccounted.mockResolvedValue({ ok: false, kind: 'x', message: 'y' });
});

describe('GET /api/debug/fuel', () => {
  it('is a 401 signed out, with no Google call', async () => {
    m.auth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(m.getDirectionsAccounted).not.toHaveBeenCalled();
  });

  it('is a 403 for a signed-in user who is not an admin, with no Google call', async () => {
    m.auth.mockResolvedValue({ user: { id: 'u1', email: 'someone@example.com' } });
    m.isAdminEmail.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(m.getDirectionsAccounted).not.toHaveBeenCalled();
    expect(m.searchFuelAlongRouteAccounted).not.toHaveBeenCalled();
  });

  it('is a 503 when the session store is down — never a sign-out', async () => {
    m.auth.mockRejectedValue(new SessionStoreUnavailableError());
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it('runs the checks for an admin', async () => {
    m.auth.mockResolvedValue({ user: { id: 'admin1', email: 'admin@example.com' } });
    m.isAdminEmail.mockResolvedValue(true);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(m.getDirectionsAccounted).toHaveBeenCalledTimes(1);
    expect(m.getDefaultVehicleForUser).toHaveBeenCalledWith('admin1');
  });
});
