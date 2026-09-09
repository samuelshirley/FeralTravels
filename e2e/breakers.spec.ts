import { test, expect, type Page } from '@playwright/test';
import { login, uniqueEmail } from './fixtures/auth';
import { cleanupPlaywrightFixtureData, seedCanonicalFixture } from './fixtures/test-trip';
import {
  clearGlobalSpend,
  levelOf,
  readBreakerState,
  seedGlobalSpend,
  setPennyLock,
} from './fixtures/breakers';

/**
 * The global circuit breakers, from the outside.
 *
 * `src/server/payments/breakers.test.ts` proves the arithmetic — every
 * threshold edge, both fail directions, which gate each breaker guards. What it
 * cannot prove is that the arithmetic is WIRED to the route that spends the
 * money, and that is the whole failure mode this defence has: a breaker that
 * evaluates perfectly and is never consulted looks exactly like one that works,
 * right up until the bill.
 *
 * So this spec seeds the app over a stop line and asks `/api/trip/replan` for a
 * Penny turn, which must come back 503 `circuit_open` rather than a plan.
 *
 * ── Why it runs alone, last ──
 *
 * A GLOBAL breaker is global. Seeding $26 of spend closes Penny for every other
 * spec running beside it, which would red `onboarding-flow`'s handoff for a
 * reason that is not a bug — the same problem `announcement.spec.ts` has, and
 * solved the same way: its own Playwright project, depending on the one before
 * it, so nothing is in flight while it holds the app shut. It also cleans up in
 * an `afterAll` that runs whatever happened, because the alternative is leaving
 * a preview with Penny switched off.
 *
 * ── Why the "closed again" half never calls replan ──
 *
 * Proving the breaker RE-CLOSES by asking for another Penny turn would spend
 * ~$0.085 of Anthropic on every push to prove a subtraction. The state endpoint
 * reads the same uncached snapshot the gate reads, so asserting there costs
 * nothing and asserts the same fact.
 *
 * ── What is deliberately NOT here ──
 *
 * The admin exemption. There is no way to sign in as an admin from a spec — the
 * allowlist is one real address and `/api/test/*` grants nothing — so it is
 * asserted where it can be: `breakerGate.test.ts` pins that the route passes
 * `isAdminUser` into the gate, and `breakers.test.ts` pins what the gate does
 * with it.
 */

const REPLAN_MESSAGE = 'hello';

/** $26 — one dollar past the 24-hour stop line in `payments/constants.ts`. */
const OVER_THE_DAILY_STOP_MICROCENTS = 26 * 100_000_000;

async function firstTripId(page: Page): Promise<string> {
  const res = await page.request.get('/api/trips');
  expect(res.status(), 'the fixture user should be able to list their trips').toBe(200);
  const body = (await res.json()) as { trips?: Array<{ id: string }> } | Array<{ id: string }>;
  const trips = Array.isArray(body) ? body : (body.trips ?? []);
  expect(trips.length, 'seedCanonicalFixture should have left one trip').toBeGreaterThan(0);
  return trips[0].id;
}

/**
 * Ask Penny for a turn. Returns the status and body WITHOUT asserting, because
 * every caller here is asserting something different about the refusal.
 *
 * If the gate is open this never reaches Anthropic — which is the point, and
 * also why a broken assertion in this file costs one real Penny turn rather
 * than a loop of them.
 */
async function attemptReplan(
  page: Page,
  tripId: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await page.request.post('/api/trip/replan', {
    data: {
      tripId,
      message: REPLAN_MESSAGE,
      idempotencyKey: `e2e-breaker-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status(), body };
}

test.describe.serial('Global circuit breakers', () => {
  const email = uniqueEmail();
  let tripId = '';

  test.beforeAll(async ({ browser }) => {
    // Whatever a previous run or a killed spec left behind. This project runs
    // last, after web-ui and announcement, so nothing else is in flight.
    await clearGlobalSpend().catch(() => {});
    await setPennyLock(false).catch(() => {});
    await seedCanonicalFixture(email);
    const page = await browser.newPage();
    await login(page, email);
    tripId = await firstTripId(page);
    await page.close();
  });

  test.afterAll(async () => {
    // Whatever happened above, this deployment must not be left with Penny shut
    // and $26 of phantom spend on the books. Both are idempotent.
    await clearGlobalSpend().catch(() => {});
    await setPennyLock(false).catch(() => {});
    await cleanupPlaywrightFixtureData(email).catch(() => {});
  });

  test('an idle app refuses nothing', async () => {
    /*
     * The baseline the rest of the file depends on. Without it, a spec that
     * asserts a 503 could be passing because something ELSE is refusing — and
     * "the breaker works" and "the app is broken" would look identical.
     *
     * It has already earned its place: on its first CI run it failed with
     * `worst: open` before this spec had done anything, because the rest of the
     * suite plants $22.70 of fabricated spend to drive accounts into paywall
     * states and the global 24h ceiling is $25. That is now excluded at the
     * source (`SYNTHETIC_SPEND_PROVIDER`), and this assertion is what would
     * notice it coming back.
     *
     * The message NAMES the open breakers. The first version reported only
     * `expected "ok", received "open"`, which cost a round-trip through CI to
     * answer the obvious next question.
     */
    const state = await readBreakerState();
    const tripped = state.statuses
      .filter((s) => s.level !== 'ok')
      .map((s) => `${s.id}=${s.level}(${s.value}/${s.stopAt ?? '-'})`)
      .join(', ');
    expect(state.worst, `already tripped before this spec started: ${tripped || 'none'}`).toBe('ok');
    expect(state.locked).toBe(false);
  });

  test('the manual lock stops a Penny turn with 503 circuit_open', async ({ page }) => {
    await login(page, email);
    await setPennyLock(true);

    expect((await readBreakerState()).locked).toBe(true);

    const { status, body } = await attemptReplan(page, tripId);
    expect(status, 'a locked app must refuse, and must not plan').toBe(503);
    expect(body.code).toBe('circuit_open');
    expect(body.breaker).toBe('manual_lock');
    // No poll interval: only a human clears this one, and quoting a number
    // would promise something nothing in the system is going to do.
    expect(body.retryAfterSeconds).toBeNull();

    await setPennyLock(false);
    expect((await readBreakerState()).locked).toBe(false);
  });

  test('$26 of global spend in 24h stops a Penny turn, and clearing it re-arms', async ({
    page,
  }) => {
    await login(page, email);
    await seedGlobalSpend(email, OVER_THE_DAILY_STOP_MICROCENTS);

    const tripped = await readBreakerState();
    expect(levelOf(tripped, 'anthropic_spend_24h'), 'the 24h breaker should be open').toBe('open');

    const { status, body } = await attemptReplan(page, tripId);
    expect(status).toBe(503);
    expect(body.code).toBe('circuit_open');
    expect(body.breaker).toBe('anthropic_spend_24h');
    expect(body.retryAfterSeconds).toBe(3600);

    /*
     * The refusal is NOT a paywall and NOT a sign-out, and both matter to a
     * client: the app clears the keychain on 401, and renders a subscription
     * sheet on 402. Asserting the status is 503 above is the same claim, but
     * these two say WHY it is the wrong answer, so a future change that swaps
     * the code has to argue with a named consequence.
     */
    expect(status).not.toBe(401);
    expect(status).not.toBe(402);

    await clearGlobalSpend();
    const cleared = await readBreakerState();
    expect(levelOf(cleared, 'anthropic_spend_24h'), 'clearing should re-arm the app').toBe('ok');
    expect(cleared.worst).toBe('ok');
  });

  test('the spend breaker does not close sign-in', async ({ page }) => {
    /*
     * The property that keeps a spend flood from taking the whole app down with
     * it. A driver who cannot plan can still get in, look at the itinerary they
     * already have, and delete their account — the last of which is an App
     * Store requirement and must never be behind any gate.
     */
    await seedGlobalSpend(email, OVER_THE_DAILY_STOP_MICROCENTS);
    try {
      const fresh = uniqueEmail();
      await seedCanonicalFixture(fresh);
      await login(page, fresh);
      await expect(page).toHaveURL(/\/trips/);
      expect((await page.request.get('/api/trips')).status()).toBe(200);
      await cleanupPlaywrightFixtureData(fresh).catch(() => {});
    } finally {
      await clearGlobalSpend();
    }
  });
});
