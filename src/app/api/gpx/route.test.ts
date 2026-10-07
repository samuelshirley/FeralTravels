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
  getGpxTrailsForLeg: vi.fn(),
  addGpxTrail: vi.fn(),
  getLegTripId: vi.fn(),
  writeGpxFile: vi.fn(),
}));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireUserId: m.requireUserId,
  assertTripReadableByUser: m.assertTripReadableByUser,
  assertTripOwnedByUser: m.assertTripOwnedByUser,
  assertLegOwnedByUser: m.assertLegOwnedByUser,
}));
vi.mock('@/server/repos/gpx', () => ({ getGpxTrailsForLeg: m.getGpxTrailsForLeg, addGpxTrail: m.addGpxTrail }));
vi.mock('@/server/repos/tasks', () => ({ getLegTripId: m.getLegTripId }));
vi.mock('@/lib/gpx', () => ({
  approxDistanceKm: () => 1,
  readGpxAsGeoJson: async () => ({ type: 'FeatureCollection', features: [] }),
  writeGpxFile: m.writeGpxFile,
  sanitizeFilename: (n: string) => n,
}));

import { GET, POST } from './route';
import { UUID, jsonRequest } from '@/test/routeHarness';

function upload(fields: Record<string, string>): Request {
  const form = new FormData();
  form.set('file', new File(['<gpx/>'], 'track.gpx'));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request('https://example.test/api/gpx', { method: 'POST', body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  m.requireUserId.mockResolvedValue(UUID.owner);
  m.getGpxTrailsForLeg.mockResolvedValue([]);
  m.assertTripReadableByUser.mockResolvedValue(undefined);
  m.assertTripOwnedByUser.mockResolvedValue(undefined);
  m.writeGpxFile.mockResolvedValue('saved.gpx');
  m.addGpxTrail.mockResolvedValue({ id: 'g1' });
});

describe('GET /api/gpx', () => {
  it("refuses your own tripId paired with someone else's legId", async () => {
    m.getLegTripId.mockResolvedValue(UUID.otherTrip);
    const res = await GET(jsonRequest(`/api/gpx?tripId=${UUID.trip}&legId=${UUID.leg}`, 'GET'));
    expect(res.status).toBe(404);
    expect(m.getGpxTrailsForLeg).not.toHaveBeenCalled();
  });

  it('reads the trails of a leg on the named trip', async () => {
    m.getLegTripId.mockResolvedValue(UUID.trip);
    const res = await GET(jsonRequest(`/api/gpx?tripId=${UUID.trip}&legId=${UUID.leg}`, 'GET'));
    expect(res.status).toBe(200);
    expect(m.assertTripReadableByUser).toHaveBeenCalledWith(UUID.trip, UUID.owner);
  });
});

describe('POST /api/gpx', () => {
  it('refuses a leg that is not on the named trip, before writing a file', async () => {
    m.assertLegOwnedByUser.mockResolvedValue(UUID.otherTrip);
    const res = await POST(upload({ tripId: UUID.trip, legId: UUID.leg }));
    expect(res.status).toBe(404);
    expect(m.writeGpxFile).not.toHaveBeenCalled();
  });

  it('is a 400 for a non-multipart body', async () => {
    const res = await POST(jsonRequest('/api/gpx', 'POST', { legId: UUID.leg }));
    expect(res.status).toBe(400);
  });

  it('stores an upload on a matching trip and leg', async () => {
    m.assertLegOwnedByUser.mockResolvedValue(UUID.trip);
    const res = await POST(upload({ tripId: UUID.trip, legId: UUID.leg }));
    expect(res.status).toBe(201);
    expect(m.addGpxTrail).toHaveBeenCalledWith(expect.objectContaining({ trip_id: UUID.trip, leg_id: UUID.leg }));
  });
});
