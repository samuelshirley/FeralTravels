import { test, expect, request } from '@playwright/test';
import {
  anonymousContext,
  fixturePost,
  paidUsage,
  readOtp,
  seedAccount,
  signedInAccount,
  targetBaseUrl,
  type SignedInAccount,
} from './fixtures/api';
import { uniqueEmail } from './fixtures/auth';
import { setSubscriptionState } from './fixtures/subscription';

/**
 * The limits that stand between a request and money: replan's caps and
 * replay, the OTP throttles, promo redemption, and the per-IP limit's one
 * exemption.
 *
 * NONE OF IT SPENDS. Every replan request here carries `handoff: true` (which
 * skips the message classifier) and the idempotency key of a turn planted
 * through /api/test/turn. The caps run before the replay lookup, so a cap
 * that works answers 429 — and a cap that is BROKEN falls through to the
 * replay and gets the planted turn back, $0, and the spec fails on the 200.
 * Each account's paid-call count is read again at the end to prove it.
 *
 * The 402 and the ownership 403 on replan and on onboarding are rows in
 * api-contracts.spec.ts; the admin routes' 401/403 are too.
 */

/** Plant a finished turn and hand back its key: the $0 safety net above. */
async function plantedTurn(a: SignedInAccount): Promise<string> {
  const { idempotencyKey } = await fixturePost<{ idempotencyKey: string }>('/api/test/turn', {
    action: 'seed',
    email: a.email,
    tripId: a.tripId,
    status: 'done',
    message: 'Plan my trip',
  });
  return idempotencyKey;
}

async function replan(a: SignedInAccount, idempotencyKey: string) {
  return a.api.post('/api/trip/replan', {
    data: { tripId: a.tripId, message: 'Plan my trip', handoff: true, idempotencyKey },
  });
}

test.describe('replan limits', () => {
  test('an idempotent replay returns the existing turn and runs nothing', async () => {
    const a = await signedInAccount();
    const before = await paidUsage(a.email);
    const key = await plantedTurn(a);
    const res = await replan(a, key);
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { turn: { idempotency_key: string; status: string } };
    expect(body.turn.idempotency_key).toBe(key);
    expect(body.turn.status).toBe('done');
    expect((await paidUsage(a.email)).calls).toBe(before.calls);
    await a.api.dispose();
  });

  test("the subscriber's daily $5 cap answers 429", async () => {
    const a = await signedInAccount();
    await setSubscriptionState(a.email, {
      comped: false,
      createdAtDaysAgo: 40,
      anthropicSpendUsd: 6,
      subscription: { status: 'active', source: 'fake', currentPeriodEndDaysFromNow: 20 },
    });
    const before = await paidUsage(a.email);
    const res = await replan(a, await plantedTurn(a));
    expect(res.status(), await res.text()).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/Daily AI spend cap/);
    expect((await paidUsage(a.email)).calls).toBe(before.calls);
    await a.api.dispose();
  });

  test("a trial's daily cap is a tenth of it: $0.60 already spent answers 429", async () => {
    const a = await signedInAccount();
    await setSubscriptionState(a.email, { comped: false, createdAtDaysAgo: 1, anthropicSpendUsd: 0.6 });
    const verdict = (await (await a.api.get('/api/me/entitlement')).json()) as { state: string; entitled: boolean };
    expect(verdict).toMatchObject({ state: 'trial', entitled: true });
    const res = await replan(a, await plantedTurn(a));
    expect(res.status(), await res.text()).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/\$0\.50/);
    await a.api.dispose();
  });

  test('the hourly request cap answers 429', async () => {
    // $0 request rows planted at seed time: the cap sums requests, not cost.
    const a = await signedInAccount({ replanRequestsLastHour: 1000 });
    const before = await paidUsage(a.email);
    const res = await replan(a, await plantedTurn(a));
    expect(res.status(), await res.text()).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/Hourly Penny request limit/);
    expect((await paidUsage(a.email)).calls).toBe(before.calls);
    await a.api.dispose();
  });
});

test.describe('OTP limits', () => {
  test('a second code to the same address inside the cooldown is 429 with Retry-After', async () => {
    const anon = await anonymousContext();
    const email = uniqueEmail();
    expect((await anon.post('/api/mobile/otp/send', { data: { email } })).status()).toBe(200);
    const again = await anon.post('/api/mobile/otp/send', { data: { email } });
    expect(again.status(), await again.text()).toBe(429);
    const retryAfter = Number(again.headers()['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(((await again.json()) as { retryAfter: number }).retryAfter).toBe(retryAfter);
    await anon.dispose();
  });

  test('a malformed address or code is 400', async () => {
    const anon = await anonymousContext();
    expect((await anon.post('/api/mobile/otp/send', { data: { email: 'not-an-email' } })).status()).toBe(400);
    expect(
      (await anon.post('/api/mobile/otp/verify', { data: { email: uniqueEmail(), code: '12ab' } })).status(),
    ).toBe(400);
    await anon.dispose();
  });

  test('five wrong codes burn the code: the right one is then refused too', async () => {
    const anon = await anonymousContext();
    const email = uniqueEmail();
    expect((await anon.post('/api/mobile/otp/send', { data: { email } })).status()).toBe(200);
    const code = await readOtp(email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 5; i++) {
      const res = await anon.post('/api/mobile/otp/verify', { data: { email, code: wrong } });
      expect(res.status(), `wrong attempt ${i}`).toBe(401);
    }
    const right = await anon.post('/api/mobile/otp/verify', { data: { email, code } });
    expect(right.status(), 'the real code after five misses').toBe(401);
    expect(((await right.json()) as { token?: string }).token).toBeUndefined();
    await anon.dispose();
  });
});

test.describe('promo redemption', () => {
  /** Mint a code through the guarded fixture route. Rows are left in place. */
  async function mint(email: string, opts: Record<string, unknown> = {}): Promise<string> {
    const { code } = await fixturePost<{ code: string }>('/api/test/promo', { email, ...opts });
    return code;
  }

  test('expired, wrong address, success, then used twice', async () => {
    const a = await signedInAccount();
    await setSubscriptionState(a.email, { comped: false, createdAtDaysAgo: 30, anthropicSpendUsd: 0 });
    const redeem = (code: string) => a.api.post('/api/promo/redeem', { data: { code } });

    const expired = await redeem(await mint(a.email, { expiresInDays: -1 }));
    expect(expired.status()).toBe(400);
    expect(((await expired.json()) as { code: string }).code).toBe('promo_expired');

    const someoneElse = await redeem(await mint(uniqueEmail()));
    expect(someoneElse.status()).toBe(400);
    expect(((await someoneElse.json()) as { code: string }).code).toBe('promo_wrong_account');

    const unknown = await redeem('FERAL-ZZZZ-ZZZZ');
    expect(unknown.status()).toBe(400);
    expect(((await unknown.json()) as { code: string }).code).toBe('promo_not_found');

    const code = await mint(a.email, { grantMonths: 6 });
    const ok = await redeem(code);
    expect(ok.status(), await ok.text()).toBe(200);
    const verdict = (await (await a.api.get('/api/me/entitlement')).json()) as { entitled: boolean };
    expect(verdict.entitled, 'the redeemed code opened the paywall').toBe(true);

    const twice = await redeem(code);
    expect(twice.status()).toBe(400);
    expect(((await twice.json()) as { code: string }).code).toBe('promo_already_redeemed');
    await a.api.dispose();
  });
});

test.describe('per-IP limit', () => {
  /**
   * The runner is exempt from the per-IP limits ONLY while it carries the test
   * secret header (decision I7, src/server/ipLimit.ts). This context sends no
   * secret, so it must be counted like anyone else: ten codes an hour from one
   * address, and the eleventh is refused.
   *
   * The addresses are seeded accounts so the sign-up gate (five NEW addresses a
   * day) is not what answers — the refusal has to be the otp_send bucket's.
   * Nothing else in the run is header-less, so tripping this bucket cannot
   * refuse another spec. A retry may find the bucket already full, which is
   * why the assertion is "refused within eleven", not "refused at exactly 11".
   */
  test('a caller without the test secret is refused after ten codes an hour', async () => {
    const emails = await Promise.all(Array.from({ length: 11 }, async () => (await seedAccount()).email));
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
    const bare = await request.newContext({
      baseURL: targetBaseUrl(),
      extraHTTPHeaders: bypass ? { 'x-vercel-protection-bypass': bypass } : {},
    });
    let refused: { status: number; body: Record<string, unknown> } | null = null;
    for (const email of emails) {
      const res = await bare.post('/api/mobile/otp/send', { data: { email } });
      if (res.status() === 429) {
        refused = { status: 429, body: (await res.json()) as Record<string, unknown> };
        break;
      }
      expect(res.status(), await res.text()).toBe(200);
    }
    expect(refused, 'eleven codes from one address were all sent').not.toBeNull();
    expect(refused?.body).toMatchObject({ code: 'ip_rate_limited', scope: 'otp_send' });
    expect(Number(refused?.body.retryAfterSeconds)).toBeGreaterThan(0);
    await bare.dispose();
  });
});
