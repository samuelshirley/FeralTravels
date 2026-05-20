import { test, expect } from '@playwright/test';
import { loginAsFixtureUser } from './fixtures/auth';
import { getDb, schema } from './fixtures/db';
import { FIXTURE_EMAIL } from './fixtures/constants';
import { eq, and } from 'drizzle-orm';

/**
 * Announcement popup E2E — verifies the one-time announcement flow:
 *   1. Seed an active announcement
 *   2. Log in → see the modal on /trips
 *   3. Click the dismiss button → modal disappears
 *   4. Reload → modal does NOT reappear (dismissal persisted)
 *   5. Clean up the seeded announcement
 */
test.describe('Announcement popup', () => {
  const ANNOUNCEMENT_TITLE = 'E2E Test Announcement';
  const ANNOUNCEMENT_BODY = 'This is a test announcement for E2E.';
  const ANNOUNCEMENT_BUTTON = 'Wow nice job Sam';
  let announcementId: string | null = null;

  test.beforeAll(async () => {
    const db = getDb();

    // Clean up any leftover E2E announcements
    await db
      .delete(schema.announcements)
      .where(eq(schema.announcements.title, ANNOUNCEMENT_TITLE));

    // Seed a fresh active announcement
    const [row] = await db
      .insert(schema.announcements)
      .values({
        title: ANNOUNCEMENT_TITLE,
        body: ANNOUNCEMENT_BODY,
        buttonText: ANNOUNCEMENT_BUTTON,
        active: true,
      })
      .returning();
    announcementId = row.id;
  });

  test.afterAll(async () => {
    const db = getDb();
    // Clean up the announcement + any dismissals
    if (announcementId) {
      await db
        .delete(schema.announcementDismissals)
        .where(eq(schema.announcementDismissals.announcementId, announcementId));
      await db
        .delete(schema.announcements)
        .where(eq(schema.announcements.id, announcementId));
    }
  });

  test('shows announcement on login, dismisses permanently', async ({ page }) => {
    // Also clean up any prior dismissal for the fixture user (in case of a
    // previous failed run)
    if (announcementId) {
      const db = getDb();
      await db
        .delete(schema.announcementDismissals)
        .where(
          and(
            eq(schema.announcementDismissals.announcementId, announcementId),
            eq(
              schema.announcementDismissals.userId,
              // Resolve the fixture user ID
              (
                await db
                  .select({ id: schema.users.id })
                  .from(schema.users)
                  .where(eq(schema.users.email, FIXTURE_EMAIL))
                  .limit(1)
              )[0]?.id ?? '',
            ),
          ),
        );
    }

    await loginAsFixtureUser(page);

    // The announcement modal should appear
    const modal = page.getByTestId('announcement-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal).toContainText(ANNOUNCEMENT_TITLE);
    await expect(modal).toContainText(ANNOUNCEMENT_BODY);

    // The dismiss button should have the custom text
    const dismissBtn = page.getByTestId('announcement-dismiss-btn');
    await expect(dismissBtn).toContainText(ANNOUNCEMENT_BUTTON);

    // Click dismiss
    await dismissBtn.click();

    // Modal should disappear
    await expect(page.getByTestId('announcement-modal-overlay')).not.toBeVisible({
      timeout: 5_000,
    });

    // Reload the page — the announcement should NOT reappear
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible({
      timeout: 15_000,
    });

    // Give the fetch time to resolve — modal should NOT be visible
    await page.waitForTimeout(2_000);
    await expect(page.getByTestId('announcement-modal-overlay')).not.toBeVisible();
  });
});
