import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());
vi.mock('resend', () => ({
  Resend: class {
    constructor() {
      throw new Error('pg tests must not construct a Resend client');
    }
  },
}));
const headerState = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (n: string) => headerState.values.get(n.toLowerCase()) ?? null }),
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}));

import { eq } from 'drizzle-orm';
import { emailOtpCodes, ipRequestCounters, oauthProviderKeys, otpSendThrottle } from '@/server/db/schema';
import {
  clearSendThrottle,
  getResendCooldownRemainingMs,
  OtpRateLimitError,
  sendOtpCode,
  verifyOtpCode,
} from '@/server/auth/otp';
import { checkIpLimit, ipCounterFor, pruneIpCounters } from '@/server/ipLimit';
import { loadProviderJwks, saveProviderJwks } from '@/server/repos/oauthJwks';
import { pgError, resetDb, testDb } from './harness';

/**
 * The sign-in and abuse tables, through the real modules against a real
 * Postgres. The OTP address is a fixture recipient with the test endpoints
 * on, so `sendOtpCode` runs end to end and transmits nothing.
 */

beforeEach(async () => {
  await resetDb();
  headerState.values.clear();
});
afterEach(() => vi.unstubAllEnvs());

const FIXTURE = 'playwright-pg@e2e.feraltravels.com';

describe('otp_send_throttle and email_otp_codes', () => {
  it('a send claims the throttle slot and stores the code; a second send waits', async () => {
    const { db } = await testDb();
    vi.stubEnv('E2E_TEST_ENDPOINTS', '1');
    vi.stubEnv('VERCEL_ENV', 'preview');
    const code = await sendOtpCode(` ${FIXTURE.toUpperCase()} `);
    expect(code).toMatch(/^\d{6}$/);
    const [throttle] = await db.select().from(otpSendThrottle);
    expect(throttle).toMatchObject({ email: FIXTURE, sends: 1 });
    expect(throttle.lastSentAt.getTime()).toBe(throttle.windowStartedAt.getTime());
    const [stored] = await db.select().from(emailOtpCodes);
    expect(stored).toMatchObject({ email: FIXTURE, code, attempts: 0 });
    expect(stored.expires.getTime() - stored.createdAt.getTime()).toBeGreaterThan(9 * 60_000);

    expect(await getResendCooldownRemainingMs(FIXTURE)).toBeGreaterThan(0);
    await expect(sendOtpCode(FIXTURE)).rejects.toBeInstanceOf(OtpRateLimitError);

    expect(await verifyOtpCode(FIXTURE, '000000' === code ? '111111' : '000000')).toBe(false);
    expect((await db.select().from(emailOtpCodes))[0].attempts).toBe(1);
    expect(await verifyOtpCode(FIXTURE, code)).toBe(true);
    expect(await db.select().from(emailOtpCodes)).toEqual([]);
    // A successful sign-in clears the ladder.
    expect(await db.select().from(otpSendThrottle)).toEqual([]);
  });

  it('the throttle is one row per address', async () => {
    const { db } = await testDb();
    await db.insert(otpSendThrottle).values({ email: FIXTURE, sends: 2 });
    const err = await pgError(db.insert(otpSendThrottle).values({ email: FIXTURE, sends: 1 }));
    expect(err.code).toBe('23505');
    await clearSendThrottle(FIXTURE.toUpperCase());
    expect(await db.select().from(otpSendThrottle)).toEqual([]);
  });
});

describe('ip_request_counters', () => {
  it('counts one row per (scope, ip, window), with the bigint window start exact', async () => {
    const { db } = await testDb();
    headerState.values.set('x-forwarded-for', '203.0.113.7');
    const nowMs = Date.parse('2026-03-01T10:15:00Z');
    const first = await checkIpLimit('otp_send', { nowMs });
    const second = await checkIpLimit('otp_send', { nowMs: nowMs + 60_000 });
    expect([first.count, second.count]).toEqual([1, 2]);
    expect(first).toMatchObject({ ip: '203.0.113.7', exempt: null, blocked: false });
    expect(await ipCounterFor('otp_send', '203.0.113.7', nowMs)).toBe(2);
    const rows = await db.select().from(ipRequestCounters);
    expect(rows).toHaveLength(1);
    expect(rows[0].windowStart).toBeGreaterThan(2 ** 31);
    expect(rows[0].windowStart % 1000).toBe(0);
    expect(rows[0].windowStart).toBeLessThanOrEqual(nowMs);
    const err = await pgError(
      db.insert(ipRequestCounters).values({ scope: 'otp_send', ip: '203.0.113.7', windowStart: rows[0].windowStart }),
    );
    expect(err.code).toBe('23505');
  });

  it('pruning drops only counters older than the retention window', async () => {
    const { db } = await testDb();
    const now = new Date('2026-03-10T00:00:00Z');
    await db.insert(ipRequestCounters).values([
      { scope: 'signup', ip: '198.51.100.1', windowStart: 1, updatedAt: new Date('2026-03-01T00:00:00Z') },
      { scope: 'signup', ip: '198.51.100.2', windowStart: 2, updatedAt: new Date('2026-03-09T00:00:00Z') },
    ]);
    expect(await pruneIpCounters(now)).toBe(1);
    expect((await db.select().from(ipRequestCounters)).map((r) => r.ip)).toEqual(['198.51.100.2']);
  });
});

describe('oauth_provider_keys', () => {
  it('the JWKS jsonb round-trips, and an older fetch never overwrites a newer one', async () => {
    const { db } = await testDb();
    const keys = [
      { kty: 'RSA', kid: 'k1', use: 'sig', alg: 'RS256', n: 'abc', e: 'AQAB' },
      { kty: 'EC', kid: 'k2', crv: 'P-256', x: 'x', y: 'y', key_ops: ['verify'] },
    ];
    const fetchedAt = new Date('2026-03-01T10:00:00+01:00');
    await saveProviderJwks('apple', { jwks: { keys }, fetchedAt });
    const loaded = await loadProviderJwks('apple');
    expect(loaded?.jwks).toEqual({ keys });
    expect(loaded?.fetchedAt.toISOString()).toBe('2026-03-01T09:00:00.000Z');

    await saveProviderJwks('apple', { jwks: { keys: [] }, fetchedAt: new Date('2026-02-01T00:00:00Z') });
    expect((await loadProviderJwks('apple'))?.jwks).toEqual({ keys });
    await saveProviderJwks('apple', { jwks: { keys: [keys[1]] }, fetchedAt: new Date('2026-03-02T00:00:00Z') });
    expect((await loadProviderJwks('apple'))?.jwks).toEqual({ keys: [keys[1]] });
    expect(await db.select().from(oauthProviderKeys).where(eq(oauthProviderKeys.provider, 'apple'))).toHaveLength(1);
    expect(await loadProviderJwks('google')).toBeNull();
  });
});
