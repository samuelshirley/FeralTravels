import { test, expect } from '@playwright/test';
import { signInAsNewUser } from './fixtures/auth';
import { cleanupPlaywrightFixtureData } from './fixtures/test-trip';

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

  test.afterEach(async () => {
    while (addresses.length) {
      const email = addresses.pop()!;
      await cleanupPlaywrightFixtureData(email).catch(() => {
        // Best effort: a cleanup failure must never red a passing assertion.
      });
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
      expect(res.ok(), `confirm=${JSON.stringify(confirm)} should be rejected`).toBe(false);
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
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login/);
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
