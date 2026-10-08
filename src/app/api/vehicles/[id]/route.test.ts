import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/db/client', () => ({ db: {} }));
vi.mock('@/server/auth/index', () => ({ auth: vi.fn() }));
vi.mock('@/server/auth/admin', () => ({ isAdminEmail: vi.fn() }));
vi.mock('@/server/payments', () => ({ getAccountVerdict: vi.fn(), maybeAlertThreshold: vi.fn() }));

const m = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  deleteVehicle: vi.fn(),
  getVehicleForUser: vi.fn(),
  setDefaultVehicle: vi.fn(),
  updateVehicle: vi.fn(),
}));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireUserId: m.requireUserId,
}));
vi.mock('@/server/repos/vehicles', () => ({
  deleteVehicle: m.deleteVehicle,
  getVehicleForUser: m.getVehicleForUser,
  setDefaultVehicle: m.setDefaultVehicle,
  updateVehicle: m.updateVehicle,
}));

import { DELETE, GET, PATCH } from './route';
import { UUID, jsonRequest } from '@/test/routeHarness';

const VEHICLE = '00000000-0000-4000-8000-0000000000aa';
const params = { params: { id: VEHICLE } };

beforeEach(() => {
  vi.clearAllMocks();
  m.requireUserId.mockResolvedValue(UUID.owner);
});

describe('DELETE /api/vehicles/:id', () => {
  it("is a 404 for someone else's (or no) vehicle — the same answer as every id route", async () => {
    m.deleteVehicle.mockResolvedValue({ ok: false, reason: 'not_found', error: 'Vehicle not found' });
    const res = await DELETE(jsonRequest(`/api/vehicles/${VEHICLE}`, 'DELETE'), params);
    expect(res.status).toBe(404);
    expect(m.deleteVehicle).toHaveBeenCalledWith(UUID.owner, VEHICLE);
  });

  it('is a 400 for the last vehicle, with the sentence the app shows', async () => {
    m.deleteVehicle.mockResolvedValue({
      ok: false,
      reason: 'last_vehicle',
      error: 'You need at least one vehicle. Add another first.',
    });
    const res = await DELETE(jsonRequest(`/api/vehicles/${VEHICLE}`, 'DELETE'), params);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('You need at least one vehicle. Add another first.');
  });

  it('is a 400 for the default vehicle', async () => {
    m.deleteVehicle.mockResolvedValue({ ok: false, reason: 'default_vehicle', error: 'x' });
    const res = await DELETE(jsonRequest(`/api/vehicles/${VEHICLE}`, 'DELETE'), params);
    expect(res.status).toBe(400);
  });

  it('deletes an owned spare vehicle', async () => {
    m.deleteVehicle.mockResolvedValue({ ok: true });
    const res = await DELETE(jsonRequest(`/api/vehicles/${VEHICLE}`, 'DELETE'), params);
    expect(res.status).toBe(200);
  });

  it('is a 400 for a malformed id, before the repo', async () => {
    const res = await DELETE(jsonRequest('/api/vehicles/x', 'DELETE'), { params: { id: 'x' } });
    expect(res.status).toBe(400);
    expect(m.deleteVehicle).not.toHaveBeenCalled();
  });
});

describe('GET and PATCH /api/vehicles/:id on a vehicle that is not yours', () => {
  it('GET is a 404', async () => {
    m.getVehicleForUser.mockResolvedValue(null);
    expect((await GET(jsonRequest(`/api/vehicles/${VEHICLE}`, 'GET'), params)).status).toBe(404);
  });

  it('PATCH is a 404 and writes nothing', async () => {
    m.getVehicleForUser.mockResolvedValue(null);
    const res = await PATCH(jsonRequest(`/api/vehicles/${VEHICLE}`, 'PATCH', { name: 'Mine now' }), params);
    expect(res.status).toBe(404);
    expect(m.updateVehicle).not.toHaveBeenCalled();
  });

  it('PATCH as set-default is a 404', async () => {
    m.setDefaultVehicle.mockResolvedValue(null);
    const res = await PATCH(jsonRequest(`/api/vehicles/${VEHICLE}`, 'PATCH', { is_default: true }), params);
    expect(res.status).toBe(404);
  });
});
