import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const m = vi.hoisted(() => ({
  authorized: vi.fn(),
  seedFixture: vi.fn(),
  readFixturePaidUsage: vi.fn(),
}));
vi.mock('@/server/auth/test-endpoints', () => ({ isTestRequestAuthorized: m.authorized }));
vi.mock('@/server/repos/jev', () => ({ JEV_MODES: ['off', 'compare', 'on'] }));
vi.mock('@/server/repos/testSupport', () => ({
  seedFixture: m.seedFixture,
  readFixturePaidUsage: m.readFixturePaidUsage,
}));

import { POST } from './route';
import { jsonRequest } from '@/test/routeHarness';

const EMAIL = 'playwright-x@e2e.feraltravels.com';

beforeEach(() => {
  vi.clearAllMocks();
  m.authorized.mockReturnValue(true);
  m.seedFixture.mockResolvedValue({ userId: 'u', vehicleId: 'v', tripId: 't' });
  m.readFixturePaidUsage.mockResolvedValue({ calls: 0, microcents: 0 });
});

describe('POST /api/test/seed', () => {
  it('is a 404 unless the test-endpoint guards pass, and touches nothing', async () => {
    m.authorized.mockReturnValue(false);
    const res = await POST(jsonRequest('/api/test/seed', 'POST', { action: 'paid-usage', email: EMAIL }));
    expect(res.status).toBe(404);
    expect(m.readFixturePaidUsage).not.toHaveBeenCalled();
    expect(m.seedFixture).not.toHaveBeenCalled();
  });

  it("action 'paid-usage' reads the count and seeds nothing", async () => {
    m.readFixturePaidUsage.mockResolvedValue({ calls: 2, microcents: 900 });
    const res = await POST(jsonRequest('/api/test/seed', 'POST', { action: 'paid-usage', email: EMAIL }));
    expect(await res.json()).toEqual({ ok: true, calls: 2, microcents: 900 });
    expect(m.seedFixture).not.toHaveBeenCalled();
  });

  it('passes coverageColumns through to the seed', async () => {
    const res = await POST(
      jsonRequest('/api/test/seed', 'POST', { email: EMAIL, vehicleName: 'V', tripName: 'T', coverageColumns: true }),
    );
    expect(res.status).toBe(200);
    expect(m.seedFixture).toHaveBeenCalledWith(expect.objectContaining({ coverageColumns: true }));
  });

  it('is a 400 for a body that is neither shape', async () => {
    const res = await POST(jsonRequest('/api/test/seed', 'POST', { action: 'paid-usage' }));
    expect(res.status).toBe(400);
  });
});
