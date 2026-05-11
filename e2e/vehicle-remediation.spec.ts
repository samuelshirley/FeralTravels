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

test.describe('Vehicle profile remediation overlay', () => {
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

  test('scripted steps clear the dialog and chat composer', async ({ page }) => {
    await loginAsFixtureUser(page, { redirectTo: `/trips/${fixture.tripId}` });

    const dialog = page.getByRole('dialog', { name: /Update your vehicle/i });
    await expect(dialog).toBeVisible({ timeout: 25_000 });

    await expect(page.getByText('Max hours you want to drive per day?')).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId('vehicle-remediation-input').fill('6');
    await page.getByTestId('vehicle-remediation-next').click();

    await expect(page.getByText('Max hours per week?')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('vehicle-remediation-input').fill('30');
    await page.getByTestId('vehicle-remediation-next').click();

    await expect(page.getByText(/Max consecutive driving days/i)).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('vehicle-remediation-input').fill('3');
    await page.getByTestId('vehicle-remediation-next').click();

    await expect(page.getByText(/caravan|camper|motorhome/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'No' }).click();

    await expect(dialog).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('trip-chat-composer')).toBeVisible({ timeout: 15_000 });

    const db = getDb();
    const rows = await db
      .select({
        remediation: schema.users.needsVehicleProfileRemediation,
      })
      .from(schema.users)
      .where(eq(schema.users.email, FIXTURE_EMAIL))
      .limit(1);
    expect(rows[0]?.remediation).toBe(false);
  });
});
