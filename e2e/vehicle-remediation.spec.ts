import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { loginAsFixtureUser } from './fixtures/auth';
import { FIXTURE_EMAIL } from './fixtures/constants';
import { getDb, schema } from './fixtures/db';
import {
  createRemediationPlaywrightTrip,
  deleteRemediationPlaywrightFixture,
} from './fixtures/remediation-trip';

test.describe.configure({ mode: 'serial' });

test.describe('Vehicle profile remediation gate', () => {
  let fixture: { tripId: number; vehicleId: number; userId: string };

  test.beforeAll(async () => {
    const created = await createRemediationPlaywrightTrip('Vehicle Remediation');
    fixture = {
      tripId: created.tripId,
      vehicleId: created.vehicleId,
      userId: created.userId,
    };
  });

  test.afterAll(async () => {
    await deleteRemediationPlaywrightFixture(fixture);
  });

  test('gates /trips with Penny questions, saves vehicle data, then shows trips', async ({
    page,
  }) => {
    // Navigate to /trips — the gate should intercept and show the remediation
    // overlay instead of the trips list.
    await loginAsFixtureUser(page, { redirectTo: '/trips' });

    const dialog = page.getByRole('dialog', { name: /Update your vehicle/i });
    await expect(dialog).toBeVisible({ timeout: 25_000 });

    // ── Q1: max drive hours per day ──
    await expect(page.getByText('Max hours you want to drive per day?')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('vehicle-remediation-input').fill('6');
    await page.getByTestId('vehicle-remediation-next').click();

    // ── Q2: max drive hours per week ──
    await expect(page.getByText('Max hours per week?')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('vehicle-remediation-input').fill('30');
    await page.getByTestId('vehicle-remediation-next').click();

    // ── Q3: max consecutive driving days ──
    await expect(page.getByText(/Max consecutive driving days/i)).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('vehicle-remediation-input').fill('3');
    await page.getByTestId('vehicle-remediation-next').click();

    // ── Q4: caravan/water tracking gate ──
    await expect(page.getByText(/caravan|camper|motorhome/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'No' }).click();

    // After all questions answered, the gate lifts and the trips page loads.
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('YOUR TRIPS', { exact: false })).toBeVisible({ timeout: 15_000 });

    // ── Verify vehicle fields were saved correctly in the database ──
    const db = getDb();
    const vehicleRows = await db
      .select()
      .from(schema.vehicles)
      .where(eq(schema.vehicles.id, fixture.vehicleId))
      .limit(1);

    expect(vehicleRows).toHaveLength(1);
    const v = vehicleRows[0];
    expect(v.maxDriveHoursPerDay).toBe(6);
    expect(v.maxDriveHoursPerWeek).toBe(30);
    expect(v.maxConsecutiveDriveDays).toBe(3);
    expect(v.waterTrackingEnabled).toBe(false);
    // refillDistanceKm was already set by the fixture seed (400 km)
    expect(v.refillDistanceKm).toBe(400);

    // ── Verify the user remediation flag is cleared ──
    const userRows = await db
      .select({ remediation: schema.users.needsVehicleProfileRemediation })
      .from(schema.users)
      .where(eq(schema.users.email, FIXTURE_EMAIL))
      .limit(1);
    expect(userRows[0]?.remediation).toBe(false);
  });

  test('does not show remediation gate after vehicle is complete', async ({ page }) => {
    // On a second login (after previous test completed the vehicle), the gate
    // should NOT appear — the user goes straight to the trips list.
    await loginAsFixtureUser(page, { redirectTo: '/trips' });

    await expect(page.getByText('YOUR TRIPS', { exact: false })).toBeVisible({ timeout: 15_000 });
    const dialog = page.getByRole('dialog', { name: /Update your vehicle/i });
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  });
});
