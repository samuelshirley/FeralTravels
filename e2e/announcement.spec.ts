import { test, expect, request, type APIRequestContext } from '@playwright/test';
import { loginAsFixtureUser } from './fixtures/auth';
import { testBackdoorHeaders } from './fixtures/constants';

/**
 * Announcement popup E2E — verifies the one-time announcement flow:
 *   1. Seed an active announcement (over HTTP via /api/test/announcement)
 *   2. Log in → see the modal on /trips
 *   3. Click dismiss → modal disappears
 *   4. Reload → modal does NOT reappear (dismissal persisted)
 *   5. Clean up the seeded announcement (restoring any parked real ones)
 *
 * Seeding/cleanup go through the guarded test-support API, so the spec never
 * touches the database directly.
 */
function targetBaseUrl(): string {
  return process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 4444}`;
}

async function withApi<T>(fn: (ctx: APIRequestContext) => Promise<T>): Promise<T> {
  const ctx = await request.newContext({
    baseURL: targetBaseUrl(),
    extraHTTPHeaders: testBackdoorHeaders(),
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

test.describe('Announcement popup', () => {
  const ANNOUNCEMENT_TITLE = 'E2E Test Announcement';
  const ANNOUNCEMENT_BODY = 'This is a test announcement for E2E.';
  const ANNOUNCEMENT_BUTTON = 'Wow nice job Sam';
  let announcementId: string | null = null;
  let parkedIds: string[] = [];

  test.beforeAll(async () => {
    await withApi(async (ctx) => {
      const res = await ctx.post('/api/test/announcement', {
        data: { title: ANNOUNCEMENT_TITLE, body: ANNOUNCEMENT_BODY, buttonText: ANNOUNCEMENT_BUTTON },
      });
      if (!res.ok()) throw new Error(`[e2e/announcement] seed failed (${res.status()}): ${await res.text()}`);
      const body = (await res.json()) as { announcementId: string; parkedIds: string[] };
      announcementId = body.announcementId;
      parkedIds = body.parkedIds ?? [];
    });
  });

  test.afterAll(async () => {
    if (!announcementId) return;
    await withApi(async (ctx) => {
      await ctx.delete('/api/test/announcement', { data: { announcementId, parkedIds } });
    });
  });

  test('shows announcement on login, dismisses permanently', async ({ page }) => {
    await loginAsFixtureUser(page);

    const modal = page.getByTestId('announcement-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal).toContainText(ANNOUNCEMENT_TITLE);
    await expect(modal).toContainText(ANNOUNCEMENT_BODY);

    const dismissBtn = page.getByTestId('announcement-dismiss-btn');
    await expect(dismissBtn).toContainText(ANNOUNCEMENT_BUTTON);
    await dismissBtn.click();

    await expect(page.getByTestId('announcement-modal-overlay')).not.toBeVisible({ timeout: 5_000 });

    // Reload — the announcement should NOT reappear (dismissal persisted).
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2_000);
    await expect(page.getByTestId('announcement-modal-overlay')).not.toBeVisible();
  });
});
