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
  // In order: the second test deactivates what the first one reads.
  test.describe.configure({ mode: 'serial' });
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
  // future run of every other spec. The cleanup DEACTIVATES it and keeps the
  // dismissal (rows the column-coverage job counts); it never deletes.
  test.afterAll(async () => {
    if (!announcementId) return;
    await withApi(async (ctx) => {
      const res = await ctx.delete('/api/test/announcement', { data: { announcementId, parkedIds } });
      if (!res.ok()) throw new Error(`cleanup failed (${res.status()}): ${await res.text()}`);
    });
  });

  /**
   * The contract the native AnnouncementModal is built on, asked the way the
   * app asks it (mobile/lib/api.ts): the active announcement for THIS user,
   * then a dismissal that is per-user and permanent.
   *
   * Why not a Maestro flow: an announcement is GLOBAL — the table has no user
   * column — and while this one is seeded every account on the preview sees it
   * on the trips list. The iOS shards run in parallel against the same preview,
   * so a modal seeded for one flow would pop up over every other shard's trips
   * list. The web modal this used to drive is behind the web lock (2026-09-27).
   */
  test('the active announcement is served once, then stays dismissed', async ({ page }) => {
    await signInAsNewUser(page, { seedFixture: false });

    const first = await page.request.get('/api/announcements/active');
    expect(first.ok(), await first.text()).toBe(true);
    const { announcement } = (await first.json()) as {
      announcement: { id: string; title: string; body: string; buttonText: string } | null;
    };
    expect(announcement, 'the seeded announcement was not served').not.toBeNull();
    expect(announcement!.id).toBe(announcementId);
    expect(announcement!.title).toBe(TITLE);
    expect(announcement!.body).toBe(BODY);
    expect(announcement!.buttonText).toBe(BUTTON);

    const dismissed = await page.request.post('/api/announcements/dismiss', {
      data: { announcementId: announcement!.id },
    });
    expect(dismissed.ok(), await dismissed.text()).toBe(true);

    // Gone for this user — the next launch shows nothing.
    const after = await page.request.get('/api/announcements/active');
    expect(after.ok()).toBe(true);
    expect(((await after.json()) as { announcement: unknown }).announcement).toBeNull();
  });

  test('cleanup leaves the seeded announcement inactive: served to nobody', async ({ page }) => {
    await withApi(async (ctx) => {
      const res = await ctx.delete('/api/test/announcement', { data: { announcementId, parkedIds } });
      expect(res.ok(), await res.text()).toBe(true);
    });
    // A brand-new user, who has dismissed nothing, is not served it.
    await signInAsNewUser(page, { seedFixture: false });
    const res = await page.request.get('/api/announcements/active');
    const { announcement } = (await res.json()) as { announcement: { id: string } | null };
    expect(announcement?.id ?? null).not.toBe(announcementId);
  });
});
