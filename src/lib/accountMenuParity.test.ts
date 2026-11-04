/**
 * The account menu has the same rows on iOS and on the web, in the same order.
 *
 * Sam, 2026-11-03: everything ships on both iOS and desktop, always. Feature
 * requests shipped on iOS only (PR #95) and the web menu simply had no row —
 * found by looking at the desktop dropdown. Nothing compared the two menus, so
 * nothing could have caught it.
 *
 * The ONE web-only row is Admin: the /admin guards take a session cookie and
 * reject bearer tokens, so the app could never open it. Any other difference
 * fails here.
 *
 * Read as TEXT, never imported (noMobileImportGuard.test.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** WEB_ONLY rows, each with why the app cannot have it. */
const WEB_ONLY: Record<string, string> = {
  Admin: '/admin guards are cookie-only and reject the app’s bearer token',
};

/** iOS: the `items` array in mobile/components/AccountMenu.tsx, in order. */
export function iosRows(src: string): string[] {
  const block = src.slice(src.indexOf('const items'), src.indexOf('];', src.indexOf('const items')));
  return [...block.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** Web: the open menu in AppNavbar — the text of each Link/button after "Signed in as". */
export function webRows(src: string): string[] {
  const start = src.indexOf('{open && (');
  const end = src.indexOf('<SupportModal', start);
  const menu = src.slice(src.indexOf('Signed in as', start), end);
  return [...menu.matchAll(/>\s*\n?\s*([A-Z][A-Za-z ]+?)\s*\n?\s*<\/(?:Link|button)>/g)].map((m) => m[1]);
}

describe('account menu parity (iOS ↔ web)', () => {
  const ios = iosRows(read('mobile/components/AccountMenu.tsx'));
  const web = webRows(read('src/components/AppNavbar.tsx'));

  it('reads both menus (the guard is not vacuous)', () => {
    expect(ios).toEqual(expect.arrayContaining(['Trips', 'Settings', 'Sign out']));
    expect(web).toEqual(expect.arrayContaining(['Trips', 'Settings', 'Admin', 'Sign out']));
  });

  it('the web menu is the iOS menu, plus only the documented web-only rows', () => {
    expect(web.filter((r) => !(r in WEB_ONLY))).toEqual(ios);
  });

  it('no web-only exemption is stale', () => {
    for (const row of Object.keys(WEB_ONLY)) expect(web).toContain(row);
  });
});
