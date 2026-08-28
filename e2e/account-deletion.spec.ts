import { test, expect, type Page } from '@playwright/test';
import { login, signInAsNewUser } from './fixtures/auth';
import { cleanupPlaywrightFixtureData } from './fixtures/test-trip';
import { RUN_ID } from './fixtures/constants';

/** What /api/test/deletion reports — counts and booleans, never an address. */
interface DeletionState {
  userRows: number;
  userId: string | null;
  tripsForUser: number;
  usageForUser: number;
  usageWithMarker: number;
  usageWithMarkerText: number;
  otpCodes: number;
  oauthTokenUses: number;
  verificationTokens: number;
  tombstones: Array<{
    signInProviders: string | null;
    accountCreatedAt: string | null;
    tripCount: number;
    vehicleCount: number;
    chatMessageCount: number;
    deletedBy: string;
    hasCiphertext: boolean;
    ciphertextMatchesEmail: boolean;
  }>;
}

/**
 * Ask the database directly what is left. Deletion signs you out, so there is
 * no in-app vantage point afterwards — and every assertion that goes through
 * the session is really an assertion about the session.
 */
async function deletionState(
  page: Page,
  email: string,
  opts: { userId?: string | null; marker?: string | null } = {},
): Promise<DeletionState> {
  const res = await page.request.post('/api/test/deletion', {
    data: { action: 'state', email, ...opts },
  });
  expect(res.ok(), `state read failed: ${await res.text()}`).toBe(true);
  return (await res.json()) as DeletionState;
}

/** Unique per run AND per test, so four parallel workers cannot see each other. */
function usageMarker(label: string): string {
  return `e2e-${RUN_ID}-${label}`;
}

/**
 * Account deletion, end to end.
 *
 * This is the flow App Store guideline 5.1.1(v) requires, and it is the single
 * most destructive action in the app — so the coverage is about two things in
 * equal measure: that it WORKS (the account and its data are really gone), and
 * that it CANNOT fire by accident (the confirm phrase is enforced on the server,
 * not just in the button's disabled attribute).
 *
 * Every test uses its own fixture user, seeded with the canonical trip, so the
 * "everything is gone" assertions are about data the test itself created.
 */
test.describe('Account deletion', () => {
  /**
   * Deletion leaves a `deleted_users` tombstone behind on purpose — that is the
   * feature working, not litter. But a local run would then accumulate
   * `playwright-*` rows in /admin/deleted forever, so each test hands its
   * address back. `cleanupPlaywright` drops tombstones BEFORE it looks the user
   * up, precisely so it still works once the user row is gone.
   */
  const addresses: string[] = [];
  const markers: string[] = [];

  test.afterEach(async ({ page }) => {
    while (addresses.length) {
      const email = addresses.pop()!;
      await cleanupPlaywrightFixtureData(email).catch(() => {
        // Best effort: a cleanup failure must never red a passing assertion.
      });
    }
    // Seeded usage rows are ANONYMOUS once the account goes — no user id, no
    // address — so nothing keyed on the address can find them. They have to be
    // handed back by marker or the suite leaves one orphan behind per run.
    while (markers.length) {
      const marker = markers.pop()!;
      await page.request
        .post('/api/test/deletion', { data: { action: 'cleanup-usage', marker } })
        .catch(() => {});
    }
  });

  test('the danger zone is at the foot of Settings and opens a confirm dialog', async ({ page }) => {
    addresses.push(await signInAsNewUser(page, { redirectTo: '/settings' }));

    const open = page.getByTestId('delete-account-open');
    await expect(open).toBeVisible();

    await expect(page.getByTestId('delete-account-dialog')).toHaveCount(0);
    await open.click();

    const dialog = page.getByTestId('delete-account-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Are you sure you want to delete your account?');
  });

  test('the delete button stays disabled until the phrase is typed exactly', async ({ page }) => {
    addresses.push(await signInAsNewUser(page, { redirectTo: '/settings' }));
    await page.getByTestId('delete-account-open').click();

    const confirmButton = page.getByTestId('delete-account-confirm-button');
    const input = page.getByTestId('delete-account-confirm-input');

    await expect(confirmButton).toBeDisabled();

    // A near-miss must not arm it — that is the whole point of the gesture.
    await input.fill('delete');
    await expect(confirmButton).toBeDisabled();

    await input.fill('delete my account');
    await expect(confirmButton).toBeDisabled();

    await input.fill('delete account');
    await expect(confirmButton).toBeEnabled();
  });

  test('cancel closes the dialog and leaves the account alone', async ({ page }) => {
    addresses.push(await signInAsNewUser(page, { redirectTo: '/settings' }));
    await page.getByTestId('delete-account-open').click();
    await page.getByTestId('delete-account-confirm-input').fill('delete account');

    // Armed, and the user backs out anyway. Nothing should have happened.
    await page.getByTestId('delete-account-cancel').click();
    await expect(page.getByTestId('delete-account-dialog')).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    const me = await page.request.get('/api/me');
    expect(me.ok()).toBe(true);
  });

  test('the API refuses a request without the exact confirm phrase', async ({ page }) => {
    addresses.push(await signInAsNewUser(page, { redirectTo: '/settings' }));

    // The server check is the one that matters: a UI bug, a stray fetch or a
    // replayed request must not be able to erase an account on its own.
    for (const confirm of ['', 'delete', 'yes', 'DELETE ACCOUNT!']) {
      const res = await page.request.post('/api/me/delete', { data: { confirm } });
      // 403 specifically. `!res.ok()` would pass just as happily on a 500 or a
      // 404 — i.e. on the route being broken rather than on it refusing.
      expect(res.status(), `confirm=${JSON.stringify(confirm)} should be 403`).toBe(403);
    }

    // …and the account is still there afterwards.
    const me = await page.request.get('/api/me');
    expect(me.ok()).toBe(true);
  });

  test('deleting really deletes: trips are gone and the session is dead', async ({ page }) => {
    addresses.push(await signInAsNewUser(page, { redirectTo: '/trips' }));

    // Prove there is something to lose before losing it.
    const before = await page.request.get('/api/trips');
    expect(before.ok()).toBe(true);
    expect(((await before.json()) as unknown[]).length).toBeGreaterThan(0);

    await page.goto('/settings');
    await page.getByTestId('delete-account-open').click();
    await page.getByTestId('delete-account-confirm-input').fill('delete account');
    await page.getByTestId('delete-account-confirm-button').click();

    // signOut lands on /login.
    await page.waitForURL(/\/login/, { timeout: 30_000 });

    // The session row cascaded away with the user, so the cookie is worthless.
    const after = await page.request.get('/api/trips');
    expect(after.status()).toBe(401);

    // And a protected page bounces instead of rendering.
    //
    // EITHER destination is correct, and which one you get says nothing about
    // deletion. With the web app on, a session-less browser is sent to /login.
    // With it off (WEB_APP_ENABLED=0, which is how production and the CI
    // preview run since 2026-08-28) the same browser is sent to /get-the-app
    // instead — it is not a person who needs to sign in, it is a person who
    // needs the app. The assertion is that /settings does not RENDER, which is
    // the thing this test is about; pinning the destination made it fail three
    // times for a reason that had nothing to do with account deletion.
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/(login|get-the-app)/);
  });

  test('the email-keyed rows a cascade cannot see are removed too', async ({ page }) => {
    // The regression this guards: `email_otp_codes`, `oauth_token_uses` and
    // `verificationTokens` are keyed by ADDRESS, not user id, so Postgres has no
    // idea they belong to the user and the delete cascade walks straight past
    // them. Drop the explicit cleanup from the repo and everything else about
    // this feature still passes — the address of someone who asked to be
    // forgotten just quietly stays in the database.
    const email = await signInAsNewUser(page, { redirectTo: '/settings' });
    addresses.push(email);

    // Sign-in consumed the code it used, so ask for a fresh one. No cooldown
    // applies precisely because the previous row was consumed.
    const sent = await page.request.post('/api/mobile/otp/send', { data: { email } });
    expect(sent.ok()).toBe(true);

    // There is now an unconsumed code sitting in email_otp_codes for this user.
    const before = await page.request.post('/api/test/otp', { data: { email } });
    expect(before.ok()).toBe(true);
    expect(((await before.json()) as { code?: string | null }).code).toBeTruthy();

    const deleted = await page.request.post('/api/me/delete', { data: { confirm: 'delete account' } });
    expect(deleted.ok()).toBe(true);

    // …and it is gone. This endpoint reads the table directly and grants
    // nothing, so it stays readable for a fixture address after the account is.
    const after = await page.request.post('/api/test/otp', { data: { email } });
    expect(after.ok()).toBe(true);
    expect(((await after.json()) as { code?: string | null }).code).toBeFalsy();
  });

  test('the tombstone records what the account actually held', async ({ page }) => {
    // Delete the INSERT at accountDeletion.ts and every other test in this file
    // still passes. The tombstone is the only thing deletion is supposed to
    // LEAVE, and nothing looked at it.
    const email = await signInAsNewUser(page, { redirectTo: '/settings' });
    addresses.push(email);

    const before = await deletionState(page, email);
    expect(before.userRows).toBe(1);
    expect(before.tombstones).toHaveLength(0);
    const userId = before.userId;
    expect(userId).toBeTruthy();

    const deleted = await page.request.post('/api/me/delete', {
      data: { confirm: 'delete account' },
    });
    expect(deleted.ok()).toBe(true);

    const after = await deletionState(page, email, { userId });
    expect(after.userRows).toBe(0);
    expect(after.tombstones).toHaveLength(1);

    const tomb = after.tombstones[0];
    // The fixture graph is one trip and one vehicle, so these are the counts
    // this test itself created — not a number copied out of the repo.
    expect(tomb.tripCount).toBeGreaterThanOrEqual(1);
    expect(tomb.vehicleCount).toBeGreaterThanOrEqual(1);
    expect(tomb.deletedBy).toBe('self');
    expect(tomb.accountCreatedAt).toBeTruthy();
    // An OTP user has no `accounts` row and no unexpired `oauth_token_uses`,
    // so the provider inference must land on 'otp' rather than guessing.
    expect(tomb.signInProviders).toBe('otp');
  });

  test('the tombstone address is recoverable by an admin', async ({ page }) => {
    /**
     * Doubles as a config check. `deleted_users.email_encrypted` is written
     * only when DELETED_USER_ENC_KEY is set, and its absence is silent: the
     * deletion succeeds, the row is written, and /admin/deleted just shows
     * "not recoverable" forever. The variable is not referenced by any
     * workflow, so nothing else would ever tell you it is missing.
     *
     * If this fails, set DELETED_USER_ENC_KEY in the Vercel environment this
     * suite points at (`openssl rand -base64 32`) — and note that rotating it
     * later makes every row written under the old key permanently unreadable.
     */
    const email = await signInAsNewUser(page, { redirectTo: '/settings' });
    addresses.push(email);

    const deleted = await page.request.post('/api/me/delete', {
      data: { confirm: 'delete account' },
    });
    expect(deleted.ok()).toBe(true);

    const [tomb] = (await deletionState(page, email)).tombstones;
    expect(
      tomb.hasCiphertext,
      'no ciphertext — DELETED_USER_ENC_KEY is unset on this deployment',
    ).toBe(true);
    // Round-trips: the hash found the row, and the ciphertext decrypts back to
    // the same address. Compared server-side; the plaintext never crosses the
    // wire, so this endpoint cannot be turned into a way to read addresses out.
    expect(tomb.ciphertextMatchesEmail).toBe(true);
  });

  test('usage rows survive anonymised, with the free text scrubbed', async ({ page }) => {
    /**
     * The actual privacy promise, and it was completely untested.
     *
     * `usage_events` is deliberately NOT deleted — it is the billing and error
     * record. What must go is the link to a person and the free text, because
     * `error_message` is where the user's own words end up: `penny:user-idea`
     * holds the sentence they typed, `penny:contiguity-gap` holds place names
     * from their itinerary. Three separate mechanisms have to fire, and each
     * one can be removed on its own without any other test noticing: the FK
     * SET NULL on `user_id`, the explicit UPDATE that clears `error_message`,
     * and the ORDER of that UPDATE (after the user delete, `user_id` is
     * already NULL and the scrub matches nothing).
     */
    const email = await signInAsNewUser(page, { redirectTo: '/settings' });
    addresses.push(email);
    const marker = usageMarker('scrub');
    markers.push(marker);

    const seeded = await page.request.post('/api/test/deletion', {
      data: { action: 'seed-usage', email, marker, text: 'a sentence the user typed' },
    });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    const { userId } = (await seeded.json()) as { userId: string };

    const before = await deletionState(page, email, { userId, marker });
    expect(before.usageWithMarker).toBe(1);
    expect(before.usageWithMarkerText).toBe(1);
    expect(before.usageForUser).toBeGreaterThanOrEqual(1);

    const deleted = await page.request.post('/api/me/delete', {
      data: { confirm: 'delete account' },
    });
    expect(deleted.ok()).toBe(true);

    const after = await deletionState(page, email, { userId, marker });
    expect(after.usageWithMarker, 'the usage row must survive, not be deleted').toBe(1);
    expect(after.usageWithMarkerText, 'error_message was not scrubbed').toBe(0);
    expect(after.usageForUser, 'user_id was not detached').toBe(0);
  });

  test('the rows themselves are gone, not just the session', async ({ page }) => {
    // The gap this closes: the test above asserts `GET /api/trips` → 401, which
    // an implementation that deleted `sessions` and nothing else passes. This
    // one asks the database about the user id captured BEFORE the delete.
    const email = await signInAsNewUser(page, { redirectTo: '/trips' });
    addresses.push(email);

    const before = await deletionState(page, email);
    const userId = before.userId;
    expect(before.tripsForUser).toBeGreaterThanOrEqual(1);

    const deleted = await page.request.post('/api/me/delete', {
      data: { confirm: 'delete account' },
    });
    expect(deleted.ok()).toBe(true);

    const after = await deletionState(page, email, { userId });
    expect(after.tripsForUser).toBe(0);
    expect(after.userRows).toBe(0);
    // The three email-keyed tables no cascade can reach.
    expect(after.otpCodes).toBe(0);
    expect(after.oauthTokenUses).toBe(0);
    expect(after.verificationTokens).toBe(0);
  });

  test('the address can sign up again and gets a clean account', async ({ page }) => {
    // Deletion is not a ban. Nothing consults `deleted_users` at sign-in, the
    // unique constraint on users.email is released, and the OTP rows for the
    // address were cleared — so the very next /login works with no cooldown.
    // What must NOT happen is any of the old account coming back with it.
    const email = await signInAsNewUser(page, { redirectTo: '/settings' });
    addresses.push(email);

    const firstUserId = (await deletionState(page, email)).userId;
    const deleted = await page.request.post('/api/me/delete', {
      data: { confirm: 'delete account' },
    });
    expect(deleted.ok()).toBe(true);

    // Straight back in through the real OTP flow — no seeding this time.
    await login(page, email, '/trips');

    const trips = await page.request.get('/api/trips');
    expect(trips.ok()).toBe(true);
    expect(((await trips.json()) as unknown[]).length, 'the old trips came back').toBe(0);

    const after = await deletionState(page, email);
    expect(after.userRows).toBe(1);
    expect(after.userId).not.toBe(firstUserId);
    // The tombstone stays: sign-up/delete/sign-up is two countable events, and
    // `deleted_users` is deliberately not unique on the hash.
    expect(after.tombstones).toHaveLength(1);
  });

  test('the same account cannot be deleted twice', async ({ page }) => {
    addresses.push(await signInAsNewUser(page, { redirectTo: '/settings' }));

    const first = await page.request.post('/api/me/delete', { data: { confirm: 'delete account' } });
    expect(first.ok()).toBe(true);
    expect(await first.json()).toMatchObject({ ok: true });

    // Replay on a dead session — must be an auth failure, never a second delete.
    const second = await page.request.post('/api/me/delete', { data: { confirm: 'delete account' } });
    expect(second.status()).toBe(401);
  });
});
