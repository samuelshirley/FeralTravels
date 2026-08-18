import { test, expect, request, type APIRequestContext } from '@playwright/test';
import { signInAsNewUser } from './fixtures/auth';
import { testEndpointHeaders } from './fixtures/constants';

/**
 * An active announcement pops a modal the first time a user lands on /trips,
 * and stays dismissed once dismissed.
 *
 * This runs in its own Playwright project, AFTER everything else (see
 * playwright.config.ts). An announcement is global app state — while one is
 * active it would appear over every other spec's user and swallow their clicks.
 * It is the one thing in this suite that cannot be isolated per user.
 */
function baseUrl(): string {
  return process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 4444}`;
}

async function withApi<T>(fn: (ctx: APIRequestContext) => Promise<T>): Promise<T> {
  const ctx = await request.newContext({
    baseURL: baseUrl(),
    extraHTTPHeaders: testEndpointHeaders(),
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

const TITLE = 'E2E Test Announcement';
const BODY = 'This is a test announcement for E2E.';
const BUTTON = 'Wow nice job Sam';

test.describe('Announcement', () => {
  let announcementId: string | null = null;
  let parkedIds: string[] = [];

  test.beforeAll(async () => {
    await withApi(async (ctx) => {
      const res = await ctx.post('/api/test/announcement', {
        data: { title: TITLE, body: BODY, buttonText: BUTTON },
      });
      if (!res.ok()) throw new Error(`seed failed (${res.status()}): ${await res.text()}`);
      const body = (await res.json()) as { announcementId: string; parkedIds: string[] };
      announcementId = body.announcementId;
      parkedIds = body.parkedIds ?? [];
    });
  });

  // Always restore: a leaked active announcement would pop a modal over every
  // future run of every other spec.
  test.afterAll(async () => {
    if (!announcementId) return;
    await withApi((ctx) =>
      ctx.delete('/api/test/announcement', { data: { announcementId, parkedIds } }),
    );
  });

  test('shows once, then stays dismissed', async ({ page }) => {
    await signInAsNewUser(page, { seedFixture: false });

    const modal = page.getByTestId('announcement-modal');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).toContainText(TITLE);
    await expect(modal).toContainText(BODY);

    await page.getByTestId('announcement-dismiss-btn').click();
    await expect(page.getByTestId('announcement-modal-overlay')).toBeHidden({ timeout: 10_000 });

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('announcement-modal-overlay')).toBeHidden();
  });
});
