import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/db/client', () => ({ db: {} }));
vi.mock('@/server/auth/admin', () => ({ isAdminEmail: vi.fn() }));
vi.mock('@/server/payments', () => ({ getAccountVerdict: vi.fn(), maybeAlertThreshold: vi.fn() }));

const m = vi.hoisted(() => ({ auth: vi.fn(), requireUser: vi.fn(), send: vi.fn() }));
vi.mock('@/server/auth', () => ({ auth: m.auth }));
vi.mock('@/server/auth/index', () => ({ auth: m.auth }));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireUser: m.requireUser,
}));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: m.send };
  },
}));

import { POST } from './route';
import { SessionStoreUnavailableError, UnauthorizedError } from '@/server/auth/errors';
import { jsonRequest } from '@/test/routeHarness';

const env = { ...process.env };
const FIXTURE = 'playwright-run1-w0-x-0@e2e.feraltravels.com';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  m.auth.mockResolvedValue(null);
  m.send.mockResolvedValue({ data: { id: 'email-1' }, error: null });
  process.env.AUTH_RESEND_KEY = 're_test';
  process.env.AUTH_EMAIL_FROM = 'Feral <hello@feraltravels.com>';
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  process.env = { ...env };
});

const post = (message: unknown) => POST(jsonRequest('/api/support', 'POST', { message }));

describe('POST /api/support', () => {
  it('mails support for a real sender', async () => {
    process.env.E2E_TEST_ENDPOINTS = '1';
    m.requireUser.mockResolvedValue({ id: 'u1', email: 'driver@example.com', isAdmin: false });
    const res = await post('My fuel stops are missing');
    expect(res.status).toBe(200);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0][0]).toMatchObject({ to: 'support@feraltravels.com', replyTo: 'driver@example.com' });
  });

  it('answers a fixture sender as sent and mails nobody, while test endpoints are on', async () => {
    process.env.E2E_TEST_ENDPOINTS = '1';
    m.requireUser.mockResolvedValue({ id: 'u1', email: FIXTURE, isAdmin: false });
    const res = await post('From the support-form flow');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('still mails for a fixture-shaped sender on production', async () => {
    process.env.E2E_TEST_ENDPOINTS = '1';
    process.env.VERCEL_ENV = 'production';
    m.requireUser.mockResolvedValue({ id: 'u1', email: FIXTURE, isAdmin: false });
    await post('x');
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it('is a 401 signed out', async () => {
    m.requireUser.mockRejectedValue(new UnauthorizedError());
    expect((await post('x')).status).toBe(401);
  });

  it('is a 503 when the session store is down — never a sign-out', async () => {
    m.requireUser.mockRejectedValue(new SessionStoreUnavailableError());
    expect((await post('x')).status).toBe(503);
    expect(m.send).not.toHaveBeenCalled();
  });

  it('is a 400 for an empty or oversized message', async () => {
    m.requireUser.mockResolvedValue({ id: 'u1', email: 'driver@example.com', isAdmin: false });
    expect((await post('')).status).toBe(400);
    expect((await post('x'.repeat(5001))).status).toBe(400);
    expect(m.send).not.toHaveBeenCalled();
  });

  it('is a 500 when Resend refuses, and says so', async () => {
    m.requireUser.mockResolvedValue({ id: 'u1', email: 'driver@example.com', isAdmin: false });
    m.send.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });
    expect((await post('x')).status).toBe(500);
  });
});
