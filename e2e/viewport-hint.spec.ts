import { test, expect } from '@playwright/test';
import { signInAsNewUser } from './fixtures/auth';
import { openTrip } from './fixtures/nav';

/**
 * A phone's RELOAD never paints the desktop workspace.
 *
 * `TripWorkspace` returns a different component tree per viewport, and
 * `useMediaQuery` cannot read `matchMedia` during render (hydration errors),
 * so every client's first render used to be `desktop` — the two-pane
 * workspace, painted at 430px and then unmounted for the mobile tree
 * (2026-09-04). The fix is a viewport HINT: a cookie the root layout's inline
 * script writes before first paint, read by the dynamic pages so the server
 * and the first client render agree on the phone's tree.
 *
 * Asserted by WATCHING, not by inspecting the server HTML: that HTML streams
 * the loading spinner first (the workspace fetches the trip client-side), so
 * the layout tree only ever appears on the client. A MutationObserver
 * installed before any script runs records every workspace root that mounts
 * (`data-layout` on each layout branch), in order. On a phone the record must
 * be `mobile` alone — a `desktop` or `tablet` entry, however brief, is the
 * flash. Screenshots taken as fast as the page paints land in the test output
 * for the eye-level check.
 *
 * A MutationObserver was the first attempt and recorded nothing — React's
 * inserts did not surface the stamped root through addedNodes — so this
 * samples the DOM on every animation frame instead, which is also closer to
 * the question: what did the phone PAINT.
 */
// A phone-sized Chromium, not a WebKit device profile: the suite installs
// Chromium only, and the viewport is the whole point here.
test.use({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });

const RECORDER = `
  // Every animation frame, note which workspace root is on screen. Consecutive
  // repeats collapse, so the record reads as the sequence of trees painted:
  // ['mobile'] is right, ['desktop', 'mobile'] is the flash.
  window.__layouts = [];
  (function tick() {
    const el = document.querySelector('[data-layout]');
    const cur = el ? el.getAttribute('data-layout') : null;
    if (cur && window.__layouts[window.__layouts.length - 1] !== cur) window.__layouts.push(cur);
    requestAnimationFrame(tick);
  })();
`;

test.describe('Viewport hint', () => {
  test('a reload on a phone mounts the mobile tree and never the desktop one', async ({ page, context }) => {
    await page.addInitScript(RECORDER);
    await signInAsNewUser(page);
    await openTrip(page);
    const tripUrl = page.url();
    await expect(page.locator('[data-layout="mobile"]')).toBeVisible({ timeout: 20_000 });

    // The inline script wrote the hint on that load.
    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === 'tp-viewport')?.value).toBe('mobile');

    // THE RELOAD — the case that was reported. Rapid screenshots for the eye.
    await page.goto(tripUrl, { waitUntil: 'commit' });
    for (let i = 0; i < 4; i++) {
      await page.screenshot({ path: `test-results/viewport-hint-reload-${i}.png` }).catch(() => {});
      await page.waitForTimeout(150);
    }
    await expect(page.locator('[data-layout="mobile"]')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: 'test-results/viewport-hint-reload-settled.png' });

    const mounted = await page.evaluate(() => (window as unknown as { __layouts: string[] }).__layouts);
    expect(mounted, `layout roots mounted during the reload: ${mounted.join(' → ')}`).not.toContain('desktop');
    expect(mounted).not.toContain('tablet');
    expect(mounted).toContain('mobile');
  });

  test('a fresh context with no cookie still gets a page', async ({ page }) => {
    // No hint is the old behaviour — desktop first, then the post-hydration
    // correction — and must never be an error.
    await signInAsNewUser(page);
    await openTrip(page);
    await expect(page.locator('[data-layout="mobile"]')).toBeVisible({ timeout: 20_000 });
  });
});
