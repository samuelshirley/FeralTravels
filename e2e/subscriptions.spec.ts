import { test, expect, type Page } from '@playwright/test';
import { login, uniqueEmail } from './fixtures/auth';
import { playwrightName } from './fixtures/constants';
import { openTrip } from './fixtures/nav';
import { cleanupPlaywrightFixtureData, seedCanonicalFixture } from './fixtures/test-trip';
import {
  attemptCreateTrip,
  readEntitlement,
  setSubscriptionState,
  type SubscriptionFixture,
} from './fixtures/subscription';
/**
 * The one import this suite takes from src/, and the only one worth taking.
 *
 * `src/types/entitlement.ts` is a leaf — types plus this single const, no
 * imports of its own — so pulling it into the Playwright runtime drags nothing
 * else along. The value is that the 402 contract is asserted against the
 * constant the server actually throws rather than against a string typed out
 * here, which is the kind of copy that drifts silently and then passes forever.
 */
import { PAYWALL_ERROR_CODE } from '../src/types/entitlement';

/**
 * The paywall, walked from the outside.
 *
 * Every account state in docs/design/subscriptions.md is reachable from three
 * facts a real account accumulates — its age, its Anthropic spend and its
 * subscription row — so that is all the fixture endpoint writes. It never says
 * "this user is entitled"; `getAccountVerdict` decides that from the rows, the
 * same way it will in production. What these specs exercise is the real
 * resolver against real data, through the real UI.
 *
 * ── The comped trap, stated once here because it is the whole file ──
 *
 * `isCompedEmail` (src/server/payments/comped.ts) matches
 * `playwright-*@e2e.feraltravels.com`, and `resolveAccountState` returns
 * `comped` BEFORE it looks at age, spend or subscription. Every address this
 * suite can use is on that list by design. So a paywall spec written the
 * obvious way — age the account 30 days, plant $9 of spend, assert the wall —
 * would set all that up, watch a comped account sail past it, and go green
 * while asserting nothing at all.
 *
 * Three things stop that, and they are deliberately redundant:
 *
 *   1. `comped` is a REQUIRED field on the fixture call — TypeScript here, Zod
 *      on the route. There is no default to forget. Every setup below states
 *      which side of the line its user is on, in the call itself.
 *   2. Every spec asserts the resolved `state` from `GET /api/me/entitlement`.
 *      If comping ever wins anyway, the state comes back `'comped'` and the
 *      assertion fails loudly. A suite that quietly tests nothing is worse
 *      than a red one; this is the tripwire that makes it impossible here.
 *   3. Every "no paywall" spec asserts something POSITIVE — a trip actually
 *      gets created through `POST /api/trips` — rather than only the absence
 *      of a wall. An absence is what a broken setup and a working app look
 *      like from the same distance.
 *
 * `sub-comped` then flips it the other way: comped: true with a dead trial and
 * $9 of spend, and full access. Run beside `sub-capped` (identical facts,
 * comped: false, blocked) the pair proves the flag is doing the work.
 *
 * ── What is NOT here ──
 *
 * `sub-purchase` (sandbox StoreKit), `sub-grace` (state 9 cannot occur — the
 * App Store Connect toggle ships off) and `sub-refund-requested`
 * (`CONSUMPTION_REQUEST` changes no state; it is a webhook unit test) are
 * absent for the reasons the design doc already gives. The watch spec asserts
 * the user sees nothing; it does not assert the alert email fires, because
 * there is no vantage point on this side of a fire-and-forget Resend call.
 */

/** Sensible default facts. Each spec overrides what it is actually testing. */
const DAY_ZERO: SubscriptionFixture = { comped: false, createdAtDaysAgo: 0, anthropicSpendUsd: 0 };

/**
 * Fresh user, canonical trip seeded, signed in through the real OTP flow, then
 * put into `fixture` and landed on `/trips`.
 *
 * The order matters. State is written AFTER sign-in, never before: the Auth.js
 * `signIn` event calls `syncCompedFlagOnSignIn`, and the day the OTP path gets
 * the same treatment (which would be a fix, not a bug) a `comped: false`
 * written beforehand would be reverted by the login itself — silently, and in
 * the direction that makes every paywall assertion vacuous.
 */
async function signedInWithState(page: Page, fixture: SubscriptionFixture): Promise<string> {
  const email = uniqueEmail();
  // The seeded trip is what "existing trips stay readable" is asserted against.
  await seedCanonicalFixture(email);
  await login(page, email);
  await setSubscriptionState(email, fixture);
  await page.goto('/trips');
  return email;
}

/** The block overlay on /trips. Absent means the account was not blocked. */
function notice(page: Page) {
  return page.locator('[data-block-reason]');
}

/**
 * Open the user's trip the only way a blocked account still can.
 *
 * `openTrip` clicks the card, and the card is now UNDER the overlay — that is
 * the block working, not a bug to route around. The overlay's own link to
 * Penny is the sanctioned way through, so exercising it here is also the test
 * that it exists at all.
 */
async function openTripFromOverlay(page: Page) {
  await notice(page).getByTestId('entitlement-overlay-penny').click();
  await page.waitForURL(/\/trips\/[0-9a-f-]{36}/, { timeout: 20_000 });
}

/** The button only an entitled account gets. Its absence is a courtesy, not the gate. */
function newTripButton(page: Page) {
  return page.getByRole('button', { name: '+ New trip' });
}

test.describe('Subscriptions — trial', () => {
  test('day 0: a brand-new account has no paywall and can create a trip', async ({ page }) => {
    const email = await signedInWithState(page, DAY_ZERO);

    const entitlement = await readEntitlement(page);
    expect(entitlement.state).toBe('trial');
    expect(entitlement.entitled).toBe(true);
    expect(entitlement.blockReason).toBeNull();
    // Nothing to SAY to an entitled user — but the prices still travel.
    // Settings -> Plan opens the purchase sheet in every account state, which
    // is the only way a reviewer in a fresh trial can reach the in-app
    // purchase; a payload with no prices would render an empty sheet.
    expect(entitlement.paywall).toBeNull();
    expect(entitlement.products.map((p) => p.id).sort()).toEqual([
      'com.feraltravels.ios.annual',
      'com.feraltravels.ios.monthly',
    ]);

    await expect(notice(page)).toHaveCount(0);
    await expect(newTripButton(page)).toBeVisible();

    // The positive half. `POST /api/trips` is the authority — the button being
    // drawn proves only that the page thought so.
    const created = await attemptCreateTrip(page, playwrightName('trial-day0'));
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);

    await cleanupPlaywrightFixtureData(email);
  });

  test('day 6: the last day of the trial is still full access', async ({ page }) => {
    // The boundary from the other side. `trialEndsAt` is created_at + 7 days,
    // so this is the account that must NOT be blocked — an off-by-one here
    // takes a day off everybody's trial and nothing else would notice.
    const email = await signedInWithState(page, {
      comped: false,
      createdAtDaysAgo: 6,
      anthropicSpendUsd: 0,
    });

    const entitlement = await readEntitlement(page);
    expect(entitlement.state).toBe('trial');
    expect(entitlement.entitled).toBe(true);

    await expect(notice(page)).toHaveCount(0);
    await expect(newTripButton(page)).toBeVisible();

    const created = await attemptCreateTrip(page, playwrightName('trial-day6'));
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);

    await cleanupPlaywrightFixtureData(email);
  });

  test('day 7: the wall goes up, both prices are reachable, creation is refused', async ({
    page,
  }) => {
    await signedInWithState(page, { comped: false, createdAtDaysAgo: 7, anthropicSpendUsd: 0 });

    const entitlement = await readEntitlement(page);
    expect(entitlement.state).toBe('trial_expired');
    expect(entitlement.entitled).toBe(false);
    expect(entitlement.blockReason).toBe('trial_over');
    expect(entitlement.paywall?.message).toBeTruthy();

    // BOTH prices, from the server. The design doc says $19.99 for the annual;
    // src/server/payments/constants.ts says $20 and explains why (Apple's
    // post-2022 price points allow it, and it keeps annual under 12× monthly).
    // The constants file is the authority — assert what ships.
    const productIds = entitlement.products.map((p) => p.id).sort();
    expect(productIds).toEqual([
      'com.feraltravels.ios.annual',
      'com.feraltravels.ios.monthly',
    ]);
    expect(entitlement.products.map((p) => p.priceLabel).sort()).toEqual(['$2', '$20']);

    // The web soft block: the notice appears, the button does not, and the
    // trips themselves stay readable — reading costs no Anthropic call and
    // stranding a driver mid-trip would be gratuitous.
    await expect(notice(page)).toHaveAttribute('data-block-reason', 'trial_over');
    await expect(newTripButton(page)).toHaveCount(0);
    await expect(page.getByTestId('trip-card')).toHaveCount(1);

    // The server refuses on its own authority, whatever the page drew.
    const created = await attemptCreateTrip(page, playwrightName('trial-day7'));
    expect(created.status).toBe(402);
    expect(created.body.code).toBe(PAYWALL_ERROR_CODE);
    expect(created.body.state).toBe('trial_expired');
    expect(created.body.blockReason).toBe('trial_over');

    // And in the workspace, Penny says it herself — a message in the
    // transcript, not a sheet thrown over the app.
    await openTripFromOverlay(page);
    const cta = page.getByTestId('paywall-cta');
    await expect(cta).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('trip-chat-composer')).toBeDisabled();

    // Both prices reachable, in the UI and not just in the payload.
    await cta.click();
    const plans = page.getByTestId('purchase-sheet-plan');
    await expect(plans).toHaveCount(2);
    await expect(
      page.locator('[data-testid="purchase-sheet-plan"][data-product-id="com.feraltravels.ios.monthly"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="purchase-sheet-plan"][data-product-id="com.feraltravels.ios.annual"]'),
    ).toBeVisible();
  });

  test('trial ceiling: $1.20 of spend ends the trial on day 3', async ({ page }) => {
    // Age alone would not have blocked this account — it is four days short of
    // the deadline. The block has to come from the money, which is the whole
    // point of the ceiling: seven days is a weak bound when a determined
    // account can burn $50 inside the week.
    await signedInWithState(page, {
      comped: false,
      createdAtDaysAgo: 3,
      anthropicSpendUsd: 1.2,
      suppressThresholdAlerts: true,
    });

    const entitlement = await readEntitlement(page);
    expect(entitlement.state).toBe('trial_spent');
    expect(entitlement.entitled).toBe(false);
    expect(entitlement.blockReason).toBe('trial_over');
    // Still inside the seven days — proof the state came from spend, not age.
    expect(entitlement.trialDaysRemaining).toBeGreaterThan(0);

    await expect(notice(page)).toHaveAttribute('data-block-reason', 'trial_over');
    await expect(newTripButton(page)).toHaveCount(0);

    const created = await attemptCreateTrip(page, playwrightName('trial-spent'));
    expect(created.status).toBe(402);
    expect(created.body.state).toBe('trial_spent');
  });
});

test.describe('Subscriptions — subscribed', () => {
  test('flag flip: a subscription row alone grants access, no receipt involved', async ({
    page,
  }) => {
    // The trial is thirty days dead, so nothing but the row can be letting
    // this account in. Nothing client-side was told about a purchase, no
    // receipt was validated, and the app was never asked. The server is the
    // authority and this is what that means in practice.
    const email = await signedInWithState(page, {
      comped: false,
      createdAtDaysAgo: 30,
      anthropicSpendUsd: 0,
      subscription: {
        status: 'active',
        source: 'fake',
        productId: 'com.feraltravels.ios.monthly',
        autoRenew: true,
        currentPeriodEndDaysFromNow: 30,
      },
    });

    const entitlement = await readEntitlement(page);
    expect(entitlement.state).toBe('subscribed');
    expect(entitlement.entitled).toBe(true);
    expect(entitlement.blockReason).toBeNull();

    await expect(notice(page)).toHaveCount(0);
    await expect(newTripButton(page)).toBeVisible();

    const created = await attemptCreateTrip(page, playwrightName('flag-flip'));
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);

    await cleanupPlaywrightFixtureData(email);
  });

  test('watch threshold: $3 of spend is invisible to the user', async ({ page }) => {
    // $2–$8.50 is an admin signal and nothing else. If any of this ever
    // surfaces to the subscriber, they are being told off for spending money
    // we already took. The alert email is suppressed here (see
    // suppressThresholdAlerts) and is covered by the payments unit tests —
    // there is no vantage point on a fire-and-forget send from a spec.
    const email = await signedInWithState(page, {
      comped: false,
      createdAtDaysAgo: 30,
      anthropicSpendUsd: 3,
      suppressThresholdAlerts: true,
      subscription: {
        status: 'active',
        currentPeriodEndDaysFromNow: 300,
      },
    });

    const entitlement = await readEntitlement(page);
    expect(entitlement.state).toBe('subscribed_watch');
    expect(entitlement.entitled).toBe(true);
    expect(entitlement.blockReason).toBeNull();
    // Nothing to say. The prices still travel — same reason as day 0: the
    // purchase sheet is reachable from Settings in every state, including for
    // a subscriber switching monthly to annual.
    expect(entitlement.paywall).toBeNull();
    expect(entitlement.products.map((p) => p.id).sort()).toEqual([
      'com.feraltravels.ios.annual',
      'com.feraltravels.ios.monthly',
    ]);

    await expect(notice(page)).toHaveCount(0);
    await expect(newTripButton(page)).toBeVisible();

    const created = await attemptCreateTrip(page, playwrightName('watch'));
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);

    // And nothing in the chat either — no bubble, a live composer.
    await openTrip(page);
    await expect(page.getByTestId('trip-chat-composer')).toBeEnabled({ timeout: 20_000 });
    await expect(page.getByTestId('paywall-cta')).toHaveCount(0);

    await cleanupPlaywrightFixtureData(email);
  });

  test('capped: $9 of spend blocks planning but leaves the trips readable', async ({ page }) => {
    await signedInWithState(page, {
      comped: false,
      createdAtDaysAgo: 30,
      anthropicSpendUsd: 9,
      suppressThresholdAlerts: true,
      subscription: {
        status: 'active',
        currentPeriodEndDaysFromNow: 300,
      },
    });

    const entitlement = await readEntitlement(page);
    expect(entitlement.state).toBe('subscribed_capped');
    expect(entitlement.entitled).toBe(false);
    expect(entitlement.blockReason).toBe('usage_cap');

    // The cap is not the user's fault and the copy must not read like an
    // accusation — it points at a human. Asserting the mailto is asserting
    // that this is the apologetic branch and not the sales one.
    await expect(notice(page)).toHaveAttribute('data-block-reason', 'usage_cap');
    await expect(notice(page).locator('a[href^="mailto:"]')).toBeVisible();
    await expect(newTripButton(page)).toHaveCount(0);

    const created = await attemptCreateTrip(page, playwrightName('capped'));
    expect(created.status).toBe(402);
    expect(created.body.blockReason).toBe('usage_cap');

    // Existing trips still rendered: the card is there behind the overlay, and
    // the workspace opens instead of bouncing back to /trips.
    expect(entitlement.canViewExistingTrips).toBe(true);
    await expect(page.getByTestId('trip-card')).toHaveCount(1);
    await openTripFromOverlay(page);
    await expect(page).toHaveURL(/\/trips\/[0-9a-f-]{36}/);
    await expect(page.getByTestId('leg-card')).toHaveCount(2);

    // Support, not a purchase sheet — there is nothing to buy your way out of.
    await expect(page.getByTestId('paywall-support-link')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('paywall-cta')).toHaveCount(0);
  });

  test('cancelled: auto-renew off with 30 days paid keeps FULL access', async ({ page }) => {
    /**
     * The regression this whole table exists to prevent.
     *
     * Cancelling turns off the next renewal. It returns no money — we keep the
     * full $19.99 — so serving the term they already bought is the transaction
     * completing, not a loss. Blocking here would be keeping the cash and
     * withholding the product, and it earns a refund request and a one-star
     * review in that order. The original plan had it wrong; this test is the
     * thing that stops it being written that way again.
     */
    const email = await signedInWithState(page, {
      comped: false,
      // Long past the trial, so nothing but the cancelled subscription can be
      // granting access.
      createdAtDaysAgo: 400,
      anthropicSpendUsd: 0.5,
      subscription: {
        status: 'cancelled',
        autoRenew: false,
        productId: 'com.feraltravels.ios.annual',
        currentPeriodEndDaysFromNow: 30,
      },
    });

    const entitlement = await readEntitlement(page);
    expect(entitlement.state).toBe('cancelled_in_period');
    expect(entitlement.entitled).toBe(true);
    expect(entitlement.blockReason).toBeNull();
    expect(entitlement.paywall).toBeNull();

    await expect(notice(page)).toHaveCount(0);
    await expect(newTripButton(page)).toBeVisible();

    const created = await attemptCreateTrip(page, playwrightName('cancelled'));
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);

    await openTrip(page);
    await expect(page.getByTestId('trip-chat-composer')).toBeEnabled({ timeout: 20_000 });
    await expect(page.getByTestId('paywall-cta')).toHaveCount(0);

    await cleanupPlaywrightFixtureData(email);
  });

  test('expired: a period that ended yesterday is a wall, even on an "active" row', async ({
    page,
  }) => {
    // Deliberately status `active` with a period end in the past, which is
    // what a missing renewal webhook looks like from here. The clock is the
    // authority, not the stale status — the alternative is free access for as
    // long as a webhook is missing.
    await signedInWithState(page, {
      comped: false,
      createdAtDaysAgo: 400,
      anthropicSpendUsd: 0,
      subscription: {
        status: 'active',
        autoRenew: true,
        productId: 'com.feraltravels.ios.monthly',
        currentPeriodEndDaysFromNow: -1,
      },
    });

    const entitlement = await readEntitlement(page);
    expect(entitlement.state).toBe('expired');
    expect(entitlement.entitled).toBe(false);
    expect(entitlement.blockReason).toBe('subscription_over');

    await expect(notice(page)).toHaveAttribute('data-block-reason', 'subscription_over');
    await expect(newTripButton(page)).toHaveCount(0);

    const created = await attemptCreateTrip(page, playwrightName('expired'));
    expect(created.status).toBe(402);
    expect(created.body.state).toBe('expired');

    // The block covers the page rather than sitting above it, and the trips
    // they already made are still rendered underneath — covered, not deleted.
    expect(entitlement.canViewExistingTrips).toBe(true);
    await expect(page.getByTestId('trip-card')).toHaveCount(1);
    // The overlay's action is the purchase sheet, the same one Penny's bubble
    // opens. "Continue on iPhone" lives inside it, because the web cannot take
    // money. Asserted by label rather than href: NEXT_PUBLIC_APP_STORE_URL is
    // an env var (the numeric app id is minted at first submission), so the URL
    // is not something a spec can assert on. The label is ours.
    await notice(page).getByTestId('entitlement-overlay-cta').click();
    await expect(
      page.getByTestId('purchase-sheet').getByTestId('purchase-sheet-app-store-link'),
    ).toBeVisible();
  });

  test('refunded: closed completely, including the trips already made', async ({ page }) => {
    // The one state where reading also stops. Apple returned the money, so the
    // access it bought ended with it — and a bookmarked trip URL must not be
    // the way around the notice.
    await signedInWithState(page, {
      comped: false,
      createdAtDaysAgo: 400,
      anthropicSpendUsd: 0,
      subscription: {
        status: 'refunded',
        productId: 'com.feraltravels.ios.annual',
        currentPeriodEndDaysFromNow: 200,
      },
    });

    const entitlement = await readEntitlement(page);
    expect(entitlement.state).toBe('refunded');
    expect(entitlement.entitled).toBe(false);
    expect(entitlement.blockReason).toBe('revoked');
    expect(entitlement.canViewExistingTrips).toBe(false);

    await expect(notice(page)).toHaveAttribute('data-block-reason', 'revoked');
    await expect(newTripButton(page)).toHaveCount(0);
    // Not merely hidden behind a wall — not rendered at all.
    await expect(page.getByTestId('trip-card')).toHaveCount(0);

    const created = await attemptCreateTrip(page, playwrightName('refunded'));
    expect(created.status).toBe(402);
    expect(created.body.blockReason).toBe('revoked');

    // The direct URL bounces back to the explanation rather than 404ing: the
    // support address is on /trips, and this user may well think it is wrong.
    const trips = await page.request.get('/api/trips');
    const rows = (await trips.json()) as Array<{ id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    await page.goto(`/trips/${rows[0].id}`);
    await expect(page).toHaveURL(/\/trips$/);
    await expect(notice(page)).toHaveAttribute('data-block-reason', 'revoked');
  });
});

test.describe('Subscriptions — comped', () => {
  test('comped: a dead trial and $9 of spend still means full access', async ({ page }) => {
    /**
     * The same facts as `sub-capped` — thirty days old, no subscription, $9 of
     * Anthropic spend — with `comped: true` as the only difference. Capped
     * blocks; this does not. Run as a pair they prove the flag is what is
     * doing the work, not the setup.
     *
     * Comped has to skip the CAP as well as the paywall: the author's own
     * account and CI are the two heaviest spenders in the whole dataset, and a
     * threshold that exists to protect revenue they do not generate would red
     * the build for reasons that have nothing to do with the code.
     */
    const email = await signedInWithState(page, {
      comped: true,
      createdAtDaysAgo: 30,
      anthropicSpendUsd: 9,
      suppressThresholdAlerts: true,
    });

    const entitlement = await readEntitlement(page);
    expect(entitlement.state).toBe('comped');
    expect(entitlement.entitled).toBe(true);
    expect(entitlement.blockReason).toBeNull();
    expect(entitlement.paywall).toBeNull();

    await expect(notice(page)).toHaveCount(0);
    await expect(newTripButton(page)).toBeVisible();

    const created = await attemptCreateTrip(page, playwrightName('comped'));
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);

    await cleanupPlaywrightFixtureData(email);
  });
});

test.describe('Subscriptions — the public edge', () => {
  test('signed out: a stranger gets a way in, not a bare wall', async ({ page }) => {
    /**
     * A signed-out visitor must never meet the paywall. They have not had a
     * trial to spend, there is nothing to sell them yet, and a wall in front
     * of someone who has never had an account is just a closed door.
     *
     * NOTE on the design doc: it specifies a marketing landing page with an
     * App Store link at `/`. That page does not exist yet — `src/app/page.tsx`
     * redirects to `/login`, which is where sign-in and the legal links live.
     * So this asserts the property that actually matters and is testable
     * today: a stranger is handed sign-in, and no entitlement machinery
     * touches them. Tighten it to assert the landing page when there is one.
     */
    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(/\/login/);

    // A way in, both ways in.
    await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
    await expect(page.getByRole('button', { name: /email me a code/i })).toBeVisible();

    // And no block notice anywhere — signed out is not a blocked state.
    await expect(notice(page)).toHaveCount(0);

    // A deep link behaves the same way rather than showing a wall.
    await page.goto('/trips');
    await expect(page).toHaveURL(/\/login/);
    await expect(notice(page)).toHaveCount(0);
  });

  test('the legal pages stay public while a paywalled account exists', async ({ page, request }) => {
    /**
     * This overlaps e2e/legal-pages.spec.ts ON PURPOSE.
     *
     * /privacy, /terms and /support were once unreachable signed-out, and that
     * cost an App Review cycle. A site-wide paywall is the single most likely
     * way to regress it: whoever adds one reaches for the layout or the
     * middleware, and those three pages go with everything else. legal-pages
     * would catch it, but only by accident of running at all — nothing in that
     * file connects the failure to the paywall. This does, so the next person
     * to widen the gate reads the reason in the test that broke.
     *
     * The paywalled account is set up first and asserted first, so this cannot
     * pass on an environment where the gate is switched off entirely.
     */
    await signedInWithState(page, { comped: false, createdAtDaysAgo: 7, anthropicSpendUsd: 0 });
    const entitlement = await readEntitlement(page);
    expect(entitlement.entitled, 'the paywall must actually be live for this to mean anything').toBe(
      false,
    );

    // `request` is a context of its own with no cookies from `page` — this is
    // the anonymous crawler, which is who the requirement is about.
    for (const path of ['/privacy', '/terms', '/support']) {
      const res = await request.get(path);
      expect(res.status(), `${path} must be 200 for a signed-out visitor`).toBe(200);
      expect(res.url(), `${path} must not redirect`).toContain(path);

      const body = await res.text();
      expect(body, `${path} rendered the sign-in page`).not.toContain('login-google-button');
      expect(body, `${path} rendered a paywall`).not.toContain('data-block-reason');
    }
  });
});
