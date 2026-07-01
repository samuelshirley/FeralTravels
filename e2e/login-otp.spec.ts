import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { E2E_OTP_EMAIL, isOtpE2EConfigured } from './fixtures/constants';
import { fetchOtpCodeForEmail } from './fixtures/otp-db';
import { getDb, schema } from './fixtures/db';

/**
 * Real OTP UI flow: /login → submit email → Resend sends → /login/verify →
 * enter the 6-digit code → /trips. The code is read from `email_otp_codes`
 * (same value as in the email) so we don't need an inbox API or IMAP.
 *
 * Set E2E_OTP_EMAIL in .env to a dedicated address on your verified domain.
 * Without it this file auto-skips so a fresh checkout still passes.
 */
test.describe('Email OTP login', () => {
  test.skip(!isOtpE2EConfigured(), 'E2E_OTP_EMAIL not set — see .env.example');

  // Ensure the OTP user has a usable default vehicle so they land on the
  // trips list with content to assert on. Modelled on a real Hilux Surf setup.
  test.beforeAll(async () => {
    const db = getDb();
    const [user] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, E2E_OTP_EMAIL))
      .limit(1);
    if (!user) return; // first-ever run — the user row won't exist until the OTP flow creates it

    // Upsert: if a vehicle already exists, patch it complete; otherwise create one.
    const existing = await db
      .select({ id: schema.vehicles.id })
      .from(schema.vehicles)
      .where(eq(schema.vehicles.userId, user.id))
      .limit(1);

    // MVP vehicle is just name + comfortable range (hard-max optional, defaults
    // to comfortable). The old driving-cadence / dump-station columns were
    // dropped (migrations 0014/0015) — don't set them here.
    const completeVehicle = {
      name: 'E2E Hilux',
      isDefault: true,
      comfortableRangeKm: 500,
    };

    if (existing.length) {
      await db
        .update(schema.vehicles)
        .set(completeVehicle)
        .where(eq(schema.vehicles.id, existing[0].id));
    } else {
      await db
        .insert(schema.vehicles)
        .values({ userId: user.id, ...completeVehicle });
    }

    // Give the user at least one trip so the /trips list has content to assert
    // on after login. (/trips no longer auto-creates a trip on zero trips, so
    // this is about a stable assertion target, not avoiding a redirect.)
    const existingTrips = await db
      .select({ id: schema.trips.id })
      .from(schema.trips)
      .where(eq(schema.trips.userId, user.id))
      .limit(1);

    if (!existingTrips.length) {
      await db.insert(schema.trips).values({
        userId: user.id,
        name: 'OTP E2E Trip',
        status: 'planning',
        onboardingState: 'done',
      });
    }
  });

  test('round-trip: send code → verify with DB-backed code → land on /trips', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.locator('input[name="email"]').fill(E2E_OTP_EMAIL);
    await Promise.all([
      page.waitForURL(/\/login\/verify/, { timeout: 15_000 }),
      page.getByRole('button', { name: /email me a code/i }).click(),
    ]);

    await expect(page.locator('text=/6-digit code/i')).toBeVisible();

    const code = await fetchOtpCodeForEmail(E2E_OTP_EMAIL);
    expect(code).toMatch(/^\d{6}$/);

    const firstDigit = page
      .locator('input[aria-label="Digit 1 of 6"]')
      .or(page.locator('input[autocomplete="one-time-code"]'))
      .first();
    await firstDigit.click();
    // Parallel wait: if navigation to /trips never happens (bad code, partial OTP), fail at navigationTimeout instead of expect's default.
    await Promise.all([
      page.waitForURL(/\/trips(\?|$)/, { timeout: 30_000 }),
      firstDigit.fill(code),
    ]);

    await expect(page).toHaveURL(/\/trips/);
    await expect(page.locator('h1')).toHaveText(/Trips/i);
  });
});
