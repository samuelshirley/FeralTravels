import { test, expect } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { loginAsE2eUser } from './fixtures/auth';
import {
  REMEDIATION_FIXTURE_EMAIL,
  REMEDIATION_TRIP_NAME,
  REMEDIATION_VEHICLE_NAME,
} from './fixtures/constants';
import { getDb, schema } from './fixtures/db';

test.describe.configure({ mode: 'serial' });

test.describe('Vehicle profile remediation gate', () => {
  test('gates /trips with Penny questions, saves vehicle data, then shows trips', async ({
    page,
  }) => {
    // Remediation persona has exactly one seeded trip; /trips redirects there
    // (newest-by-id). Do not assert a literal trip PK — IDs change each seed.
    await loginAsE2eUser(page, REMEDIATION_FIXTURE_EMAIL, { redirectTo: '/trips' });
    await expect(page).toHaveURL(/\/trips\/\d+/, { timeout: 15_000 });
    await expect(page.getByText(REMEDIATION_TRIP_NAME, { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // ── Q1: max drive hours per day ──
    await expect(page.getByText('Max hours you want to drive per day?')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('trip-chat-composer').fill('6');
    await page.getByTestId('trip-chat-composer').press('Enter');

    // ── Q2: max consecutive driving days (weekly hours derived as day × streak) ──
    await expect(page.getByText(/Max consecutive driving days/i)).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('trip-chat-composer').fill('3');
    await page.getByTestId('trip-chat-composer').press('Enter');

    // ── Q3: caravan/water tracking gate ──
    await expect(page.getByText(/caravan|camper|motorhome/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'No' }).click();

    // Composer hands back to Penny after remediation; confirm then trips list loads.
    await expect(
      page.getByText(/Vehicle profile updated!/i),
    ).toBeVisible({ timeout: 15_000 });
    await page.goto('/trips');
    await expect(page.getByText('YOUR TRIPS', { exact: false })).toBeVisible({ timeout: 15_000 });

    const db = getDb();
    const [personaUser] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, REMEDIATION_FIXTURE_EMAIL))
      .limit(1);
    expect(personaUser).toBeTruthy();

    const vehicleRows = await db
      .select()
      .from(schema.vehicles)
      .where(
        and(
          eq(schema.vehicles.userId, personaUser!.id),
          eq(schema.vehicles.name, REMEDIATION_VEHICLE_NAME),
        ),
      )
      .limit(1);

    expect(vehicleRows).toHaveLength(1);
    const v = vehicleRows[0];
    expect(v.maxDriveHoursPerDay).toBe(6);
    expect(v.maxDriveHoursPerWeek).toBe(18);
    expect(v.maxConsecutiveDriveDays).toBe(3);
    expect(v.waterTrackingEnabled).toBe(false);
    expect(v.refillDistanceKm).toBe(400);

    const userRows = await db
      .select({ remediation: schema.users.needsVehicleProfileRemediation })
      .from(schema.users)
      .where(eq(schema.users.email, REMEDIATION_FIXTURE_EMAIL))
      .limit(1);
    expect(userRows[0]?.remediation).toBe(false);
  });

  test('does not show remediation gate after vehicle is complete', async ({ page }) => {
    await loginAsE2eUser(page, REMEDIATION_FIXTURE_EMAIL, { redirectTo: '/trips' });

    await expect(page.getByText('YOUR TRIPS', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText('Max hours you want to drive per day?'),
    ).not.toBeVisible({ timeout: 3_000 });
  });
});
