import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());
// Nothing in this folder may reach the network. The alert paths only email
// when configured for production, which these tests are not; this makes a
// mistake there fail loudly instead of sending.
vi.mock('resend', () => ({
  Resend: class {
    constructor() {
      throw new Error('pg tests must not construct a Resend client');
    }
  },
}));

import { eq } from 'drizzle-orm';
import { breakerAlerts, promoCodes, subscriptionEvents, usageAlerts, users } from '@/server/db/schema';
import {
  alertAlreadyFired,
  applySubscriptionEvent,
  BREAKERS,
  createPromoCode,
  getAccountVerdict,
  getSubscriptionRow,
  hasEntitlement,
  invalidatePaywallSwitch,
  invalidatePennyLock,
  maybeAlertBreakers,
  maybeAlertThreshold,
  paywallEnabled,
  pennyLocked,
  PRODUCTS,
  reactivateSubscription,
  redeemPromoCode,
  revokeSubscription,
  setPaywallEnabled,
  setPaywallEnforcedForUser,
  setPennyLocked,
  type BreakerStatus,
} from '@/server/payments';
import { getSubscriptionEventsForUser } from '@/server/repos/admin';
import { logAnthropicUsage } from '@/server/repos/usage';
import { pgError, rawQuery, resetDb, seedUser, testDb } from './harness';

/**
 * Subscriptions, promo codes, the alert ledgers and the `app_meta` switches,
 * through `@/server/payments` (its one public surface) against a real
 * Postgres. The `subscriptions` table is only ever read back through
 * `getSubscriptionRow` / `getAccountVerdict`, never imported here.
 */

beforeEach(async () => {
  await resetDb();
  invalidatePaywallSwitch();
  invalidatePennyLock();
});
afterEach(() => vi.unstubAllEnvs());

const MONTHLY = PRODUCTS[0].id;

describe('subscriptions via the RevenueCat webhook', () => {
  it('an INITIAL_PURCHASE writes the row and the audit event exactly', async () => {
    const user = await seedUser();
    const periodEnd = Date.parse('2026-04-01T10:00:00+02:00');
    const eventTimeMs = Date.parse('2026-03-01T10:00:00Z');
    const payload = { event: { id: 'evt-1', type: 'INITIAL_PURCHASE', nested: { list: [1, 'two'] } } };
    const result = await applySubscriptionEvent({
      eventId: 'evt-1',
      type: 'INITIAL_PURCHASE',
      appUserId: user.id,
      transferredFrom: [],
      transferredTo: [],
      productId: MONTHLY,
      periodEndMs: periodEnd,
      eventTimeMs,
      store: 'APP_STORE',
      originalTransactionId: '2000000123456789',
      payload,
    });
    expect(result).toMatchObject({ outcome: 'applied', status: 'active', userId: user.id });

    const row = await getSubscriptionRow(user.id);
    expect(row).toMatchObject({
      status: 'active',
      source: 'apple_iap',
      productId: MONTHLY,
      originalTransactionId: '2000000123456789',
      autoRenew: true,
    });
    expect(row?.currentPeriodEnd?.toISOString()).toBe('2026-04-01T08:00:00.000Z');

    // The paywall switch fails closed to OFF; turn it on so `entitled` means something.
    await setPaywallEnabled(true);
    const verdict = await getAccountVerdict(user.id, new Date('2026-03-15T00:00:00Z'));
    expect(verdict).toMatchObject({ state: 'subscribed', entitled: true, productId: MONTHLY });
    expect(verdict.currentPeriodEnd?.toISOString()).toBe('2026-04-01T08:00:00.000Z');
    // One second past the stored period end, the same row reads as expired.
    expect(await hasEntitlement(user.id, new Date('2026-04-01T08:00:01Z'))).toBe(false);

    const [event] = await getSubscriptionEventsForUser(user.id);
    expect(event).toMatchObject({ type: 'INITIAL_PURCHASE', outcome: 'applied', eventTimeMs });
    expect(event.payload).toEqual(payload);
  });

  it('a replayed event id is a duplicate (the unique index), and a stale one is ignored', async () => {
    const user = await seedUser();
    const base = {
      appUserId: user.id,
      transferredFrom: [],
      transferredTo: [],
      productId: MONTHLY,
      periodEndMs: null,
      store: 'APP_STORE',
      originalTransactionId: null,
      payload: {},
    };
    await applySubscriptionEvent({ ...base, eventId: 'e1', type: 'RENEWAL', eventTimeMs: 2_000 });
    expect(
      (await applySubscriptionEvent({ ...base, eventId: 'e1', type: 'RENEWAL', eventTimeMs: 2_000 }))
        .outcome,
    ).toBe('ignored_duplicate');
    expect(
      (await applySubscriptionEvent({ ...base, eventId: 'e0', type: 'EXPIRATION', eventTimeMs: 1_000 }))
        .outcome,
    ).toBe('ignored_stale');
    expect((await getSubscriptionRow(user.id))?.status).toBe('active');
    const { db } = await testDb();
    const err = await pgError(
      db.insert(subscriptionEvents).values({ eventId: 'e1', type: 'X', outcome: 'applied' }),
    );
    expect(err.code).toBe('23505');
  });

  it('revoke records the prior status and reactivate restores it', async () => {
    const user = await seedUser();
    await applySubscriptionEvent({
      eventId: 'buy',
      type: 'INITIAL_PURCHASE',
      appUserId: user.id,
      transferredFrom: [],
      transferredTo: [],
      productId: MONTHLY,
      periodEndMs: Date.now() + 86_400_000,
      eventTimeMs: Date.now(),
      store: 'APP_STORE',
      originalTransactionId: 'otx',
      payload: {},
    });
    await revokeSubscription(user.id, 'admin@pg.test', 'chargeback');
    expect(await getSubscriptionRow(user.id)).toMatchObject({
      status: 'revoked',
      preRevokeStatus: 'active',
      revokedBy: 'admin@pg.test',
      revokedReason: 'chargeback',
    });
    expect((await getAccountVerdict(user.id)).state).toBe('revoked');
    await reactivateSubscription(user.id, 'admin@pg.test', 'resolved');
    expect(await getSubscriptionRow(user.id)).toMatchObject({ status: 'active', revokedAt: null });
    const types = (await getSubscriptionEventsForUser(user.id)).map((e) => e.type).sort();
    expect(types).toEqual(['ADMIN_REACTIVATE', 'ADMIN_REVOKE', 'INITIAL_PURCHASE']);
  });

  it('deleting the user takes the subscription and unlinks its events', async () => {
    const { db } = await testDb();
    const user = await seedUser();
    await applySubscriptionEvent({
      eventId: 'gone',
      type: 'INITIAL_PURCHASE',
      appUserId: user.id,
      transferredFrom: [],
      transferredTo: [],
      productId: MONTHLY,
      periodEndMs: null,
      eventTimeMs: 1,
      store: null,
      originalTransactionId: null,
      payload: {},
    });
    await db.delete(users).where(eq(users.id, user.id));
    expect(await getSubscriptionRow(user.id)).toBeNull();
    const events = await db.select().from(subscriptionEvents);
    expect(events.map((e) => [e.eventId, e.userId])).toEqual([['gone', null]]);
  });

  it('the per-account paywall flag and the 12-month spend come back as written', async () => {
    const user = await seedUser();
    await setPaywallEnforcedForUser(user.id, true);
    await logAnthropicUsage({
      userId: user.id,
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const [spend] = await rawQuery<{ c: string }>(`select sum(cost_microcents)::text as c from usage_events`);
    const verdict = await getAccountVerdict(user.id);
    expect(verdict.spendMicrocents).toBe(Number(spend.c));
    expect(verdict.enforced).toBe(true);
  });
});

describe('promo_codes', () => {
  it('a code is minted, redeemed once into a promo subscription, and audited', async () => {
    const user = await seedUser('friend@pg.test');
    const expiresAt = new Date('2027-01-01T00:00:00-05:00');
    const promo = await createPromoCode({
      email: ' Friend@PG.test ',
      note: 'beta tester',
      createdBy: 'Admin@PG.test',
      expiresAt,
      grantMonths: 6,
    });
    expect(promo).toMatchObject({ email: 'friend@pg.test', createdBy: 'admin@pg.test', grantMonths: 6 });
    expect(promo.expiresAt?.toISOString()).toBe('2027-01-01T05:00:00.000Z');

    const now = new Date('2026-03-01T12:00:00Z');
    expect(await redeemPromoCode({ userId: user.id, email: 'friend@pg.test', rawCode: promo.code, now })).toEqual({
      ok: true,
      code: promo.code,
    });
    expect(await getSubscriptionRow(user.id)).toMatchObject({ status: 'active', source: 'promo' });
    expect((await getSubscriptionRow(user.id))?.currentPeriodEnd?.toISOString()).toBe(
      '2026-09-01T12:00:00.000Z',
    );
    expect(
      await redeemPromoCode({ userId: user.id, email: 'friend@pg.test', rawCode: promo.code, now }),
    ).toEqual({ ok: false, reason: 'promo_already_redeemed' });
    const [event] = await getSubscriptionEventsForUser(user.id);
    expect(event).toMatchObject({ type: 'PROMO_REDEEMED', eventTimeMs: now.getTime() });
    expect(event.payload).toEqual({ code: promo.code, grantedTo: 'friend@pg.test', promoCodeId: promo.id });
  });

  it('the code is unique, and deleting the redeemer keeps the code', async () => {
    const { db } = await testDb();
    const user = await seedUser('x@pg.test');
    const promo = await createPromoCode({ email: 'x@pg.test', createdBy: 'a', grantMonths: 12 });
    const err = await pgError(
      db.insert(promoCodes).values({ code: promo.code, email: 'y@pg.test', createdBy: 'a', grantMonths: 6 }),
    );
    expect(err.code).toBe('23505');
    await redeemPromoCode({ userId: user.id, email: 'x@pg.test', rawCode: promo.code });
    await db.delete(users).where(eq(users.id, user.id));
    const [row] = await db.select().from(promoCodes);
    expect(row.redeemedByUserId).toBeNull();
    expect(row.redeemedAt).not.toBeNull();
  });
});

describe('alert ledgers', () => {
  it('usage_alerts: a threshold fires once per user, with the bigint value kept', async () => {
    const { db } = await testDb();
    vi.stubEnv('AUTH_RESEND_KEY', '');
    const user = await seedUser();
    const big = 5_000_000_000;
    await maybeAlertThreshold(user.id, big, { watch: true, stop: false });
    await maybeAlertThreshold(user.id, big + 1, { watch: true, stop: false });
    expect(await alertAlreadyFired(user.id, 'watch')).toBe(true);
    expect(await alertAlreadyFired(user.id, 'stop')).toBe(false);
    const rows = await db.select().from(usageAlerts);
    expect(rows.map((r) => [r.threshold, r.microcentsAtFiring])).toEqual([['watch', big]]);
  });

  it('breaker_alerts: one row per (breaker, level), re-armed only after the cooldown', async () => {
    const { db } = await testDb();
    vi.stubEnv('VERCEL_ENV', 'preview');
    const spec = BREAKERS.find((b) => b.id !== 'manual_lock')!;
    const status: BreakerStatus = {
      id: spec.id,
      gate: spec.gate,
      unit: spec.unit,
      level: 'alert',
      value: 3_000_000_000.4,
      alertAt: spec.alertAt,
      stopAt: spec.stopAt,
      windowHours: spec.windowHours,
      label: spec.label,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await maybeAlertBreakers([status]);
    await maybeAlertBreakers([{ ...status, value: 1 }]);
    expect(warn).toHaveBeenCalledTimes(1); // the second is inside the cooldown
    warn.mockRestore();
    const rows = await db.select().from(breakerAlerts);
    expect(rows.map((r) => [r.breaker, r.level, r.valueAtFiring])).toEqual([
      [spec.id, 'alert', 3_000_000_000],
    ]);
  });
});

describe('app_meta switches', () => {
  it('the paywall switch and the Penny lock persist and read back', async () => {
    expect(await paywallEnabled()).toBe(false);
    await setPaywallEnabled(true);
    expect(await paywallEnabled()).toBe(true);
    await setPaywallEnabled(false);
    expect(await paywallEnabled()).toBe(false);
    await setPennyLocked(true);
    expect(await pennyLocked()).toBe(true);
    expect(await rawQuery(`select key, value from app_meta order by key`)).toEqual([
      { key: 'paywall_enabled', value: '0' },
      { key: 'penny_locked', value: '1' },
    ]);
  });
});
