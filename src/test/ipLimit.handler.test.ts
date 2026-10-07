import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * The per-IP limit at the HANDLER, not the arithmetic (that is
 * src/lib/ipLimit.test.ts): `POST /api/mobile/otp/send` with the real
 * `assertIpAllowed`, the real decision and the real test-runner exemption,
 * against an in-memory counter standing in for `ip_request_counters`.
 *
 * Over HTTP a runner shares one address with every spec, so tripping a bucket
 * there would break the rest of the run; e2e/money-limits.spec.ts does it
 * exactly once, header-less. The rest of the bucket's behaviour is here.
 */

const state = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  counts: new Map<string, number>(),
  dbDown: false,
  sendOtpCode: vi.fn(),
  assertSignupGateOpen: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (n: string) => state.headers.get(n.toLowerCase()) ?? null }),
}));

// One upsert chain: insert().values().onConflictDoUpdate().returning().
vi.mock('@/server/db/client', () => ({
  db: {
    insert: () => ({
      values: (v: { scope: string; ip: string; windowStart: number }) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            if (state.dbDown) throw new Error('connection refused');
            const key = `${v.scope}|${v.ip}|${v.windowStart}`;
            const count = (state.counts.get(key) ?? 0) + 1;
            state.counts.set(key, count);
            return [{ count }];
          },
        }),
      }),
    }),
    delete: () => ({ where: () => ({ returning: async () => [] }) }),
  },
}));
vi.mock('@/server/auth/otp', () => ({
  OtpRateLimitError: class extends Error {},
  retryAfterSeconds: () => 1,
  sendOtpCode: state.sendOtpCode,
}));
vi.mock('@/server/payments', () => ({ assertSignupGateOpen: state.assertSignupGateOpen }));
vi.mock('@/server/auth/admin', () => ({
  isOnAdminAllowlist: (email: string) => email === 'admin@example.com',
}));
vi.mock('@/server/auth/guards', async () => {
  const errors = await import('@/server/auth/errors');
  return {
    HttpError: errors.HttpError,
    errorResponse: (err: unknown) => {
      const e = err as { status?: number; message?: string; details?: Record<string, unknown> };
      return Response.json({ error: e.message, ...(e.details ?? {}) }, { status: e.status ?? 500 });
    },
  };
});

import { POST } from '@/app/api/mobile/otp/send/route';

function send(email: string): Promise<Response> {
  return POST(
    new Request('https://example.test/api/mobile/otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }),
  );
}

const env = { ...process.env };

beforeEach(() => {
  state.headers = new Map([['x-vercel-forwarded-for', '203.0.113.7']]);
  state.counts.clear();
  state.dbDown = false;
  state.sendOtpCode.mockReset().mockResolvedValue('123456');
  state.assertSignupGateOpen.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.E2E_TEST_ENDPOINTS;
  delete process.env.E2E_TEST_ENDPOINTS_SECRET;
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  process.env = { ...env };
});

describe('otp_send: ten codes an hour from one address', () => {
  it('sends ten, refuses the eleventh with 429 ip_rate_limited and a real wait, and mails nobody', async () => {
    for (let i = 0; i < 10; i++) expect((await send(`u${i}@example.com`)).status).toBe(200);
    const res = await send('u10@example.com');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; scope: string; retryAfterSeconds: number };
    expect(body).toMatchObject({ code: 'ip_rate_limited', scope: 'otp_send' });
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(state.sendOtpCode).toHaveBeenCalledTimes(10);
  });

  it('counts each address on its own', async () => {
    for (let i = 0; i < 10; i++) await send(`u${i}@example.com`);
    state.headers.set('x-vercel-forwarded-for', '198.51.100.9');
    expect((await send('other@example.com')).status).toBe(200);
  });

  it('exempts the test runner only when it carries the matching secret', async () => {
    process.env.E2E_TEST_ENDPOINTS = '1';
    process.env.E2E_TEST_ENDPOINTS_SECRET = 'per-run-secret';
    state.headers.set('x-e2e-test-secret', 'per-run-secret');
    for (let i = 0; i < 15; i++) expect((await send(`r${i}@example.com`)).status).toBe(200);

    // Same runner, header dropped: counted like anyone (decision I7).
    state.headers.delete('x-e2e-test-secret');
    for (let i = 0; i < 10; i++) expect((await send(`s${i}@example.com`)).status).toBe(200);
    expect((await send('s10@example.com')).status).toBe(429);
  });

  it('a wrong secret is not an exemption', async () => {
    process.env.E2E_TEST_ENDPOINTS = '1';
    process.env.E2E_TEST_ENDPOINTS_SECRET = 'per-run-secret';
    state.headers.set('x-e2e-test-secret', 'guessed');
    for (let i = 0; i < 10; i++) await send(`g${i}@example.com`);
    expect((await send('g10@example.com')).status).toBe(429);
  });

  it('never exempts the runner on production, secret or not', async () => {
    process.env.E2E_TEST_ENDPOINTS = '1';
    process.env.E2E_TEST_ENDPOINTS_SECRET = 'per-run-secret';
    process.env.VERCEL_ENV = 'production';
    state.headers.set('x-e2e-test-secret', 'per-run-secret');
    for (let i = 0; i < 10; i++) await send(`p${i}@example.com`);
    expect((await send('p10@example.com')).status).toBe(429);
  });

  it('exempts an allowlisted admin address', async () => {
    for (let i = 0; i < 12; i++) expect((await send('admin@example.com')).status).toBe(200);
  });

  it('fails OPEN when the counter cannot be written — the breaker is still in front', async () => {
    state.dbDown = true;
    for (let i = 0; i < 12; i++) expect((await send(`d${i}@example.com`)).status).toBe(200);
  });

  it('refuses before the sign-up gate is even asked', async () => {
    for (let i = 0; i < 10; i++) await send(`u${i}@example.com`);
    state.assertSignupGateOpen.mockClear();
    await send('u10@example.com');
    expect(state.assertSignupGateOpen).not.toHaveBeenCalled();
  });

  it('a request with no address at all is not counted into a shared bucket', async () => {
    state.headers = new Map();
    for (let i = 0; i < 12; i++) expect((await send(`n${i}@example.com`)).status).toBe(200);
    expect(state.counts.size).toBe(0);
  });
});
