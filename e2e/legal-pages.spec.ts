import { test, expect } from '@playwright/test';

/**
 * /privacy, /terms and /support must be reachable by a stranger.
 *
 * These three URLs are pasted into App Store Connect and the Google OAuth
 * consent screen, and both Apple's reviewer and Google's brand-verification
 * crawler fetch them with no session and no cookies. A sign-in redirect, a
 * 500, or a page that only renders after client-side JS is a rejection — and
 * the loop back from a rejection is measured in days.
 *
 * They are public by construction (the `(legal)` route group calls no `auth()`
 * anywhere), which is precisely why this needs a test: nothing in the code
 * says "these must stay anonymous". Someone adds a session read to the root
 * layout, or moves middleware.ts into src/ where Next actually loads it, and
 * the pages quietly start 307ing. Nothing else in the suite would notice —
 * every other spec signs in first.
 *
 * Deliberately runs BOTH ways: `request` proves the raw HTTP response a
 * crawler gets, `page` proves a human sees rendered content and not a shell.
 */

const PAGES = [
  { path: '/privacy', heading: 'Privacy', title: /Privacy Policy/i },
  { path: '/terms', heading: 'Terms of Service', title: /Terms of Service/i },
  { path: '/support', heading: 'Support', title: /Support/i },
] as const;

test.describe('public legal pages', () => {
  for (const { path, heading, title } of PAGES) {
    test(`${path} is 200 for an anonymous crawler`, async ({ request }) => {
      // No browser, no cookies, and redirects followed — so a 307 to /login
      // shows up as a login page in the body rather than as a non-200 status.
      const res = await request.get(path);

      expect(res.status(), `${path} must be 200, got ${res.status()}`).toBe(200);
      expect(res.url(), `${path} must not redirect`).toContain(path);

      const body = await res.text();
      expect(body).toContain(`<h1>${heading}</h1>`);
      expect(body, `${path} rendered the sign-in page`).not.toContain('login-google-button');
    });

    test(`${path} renders for a signed-out visitor`, async ({ page }) => {
      const res = await page.goto(path);

      expect(res?.status()).toBe(200);
      expect(page.url()).not.toContain('/login');
      await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
      await expect(page).toHaveTitle(title);

      /**
       * The layout's own footer — the reviewer's route from one document to
       * the next two without going through the app.
       *
       * `exact: true` is load-bearing, not tidiness. getByRole's `name` is a
       * case-insensitive SUBSTRING match by default, so plain 'Privacy' also
       * matches the "Privacy Policy" link in the body of /terms, and 'Support'
       * also matches "Contact support" on /support — two matches, strict mode
       * violation, a red test on two pages that are working perfectly.
       */
      await expect(page.getByRole('link', { name: 'Privacy', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Terms', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Support', exact: true })).toBeVisible();
    });
  }

  test('/legal/ assets are public too', async ({ request }) => {
    // The support page's photo lives under /legal/. A public page whose image
    // 404s or 307s looks broken to the one person whose opinion decides the
    // submission.
    const res = await request.get('/legal/support-dogs.jpg');

    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image');
  });

  test('/support gives a reviewer a way to make contact', async ({ page }) => {
    // App Store Connect's Support URL field exists so a user with a problem
    // can reach a human. A page with no contact route satisfies the field and
    // not the requirement.
    await page.goto('/support');

    const mailto = page.locator('a[href^="mailto:"]');
    await expect(mailto.first()).toBeVisible();
    expect(await mailto.first().getAttribute('href')).toContain('@');

    await expect(page.locator('img[src="/legal/support-dogs.jpg"]')).toBeVisible();
  });

  test('/privacy documents account deletion', async ({ page }) => {
    // Apple guideline 5.1.1(v) is not satisfied by a delete button alone —
    // the policy has to say what deletion does and what survives it. This is
    // also the assertion that fails if the policy and the code drift: the
    // tombstone is real, retained, and named on the page.
    await page.goto('/privacy');

    await expect(page.getByRole('heading', { name: 'Deleting everything' })).toBeVisible();

    const body = (await page.locator('article').innerText()).toLowerCase();

    // Each of these is a sentence the policy makes BECAUSE the code does it,
    // so the assertion fails if either side drifts. Quoted from the page
    // rather than paraphrased — an earlier version of this test looked for
    // "anonymised", a word the policy has never used, and failed on wording
    // it had invented itself.
    expect(body).toContain('two things outlive the deletion');
    // The two `deleted_users` email columns: emailHash and emailEncrypted.
    expect(body).toContain('one-way fingerprint');
    expect(body).toContain('encrypted');
    // usage_events: kept, user_id detached, error_message scrubbed.
    expect(body).toContain('unlinked from you');
    expect(body).toContain('erased');
  });

  test('the sign-in page links out to the legal pages', async ({ page }) => {
    // The one page a reviewer is guaranteed to see. Both links must be there
    // and both must lead somewhere real.
    await page.goto('/login');

    const privacy = page.getByRole('link', { name: 'Privacy', exact: true });
    const terms = page.getByRole('link', { name: 'Terms', exact: true });
    await expect(privacy).toBeVisible();
    await expect(terms).toBeVisible();

    await privacy.click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  });
});
