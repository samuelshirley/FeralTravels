import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every page either calls the gate or is on the list of pages that must not.
 *
 * This is the guard the PAYWALL never got, and the omission is instructive:
 * `PAYWALL_EXEMPT_PREFIXES` was written, documented at length and unit-tested,
 * and then nothing ever called `isPaywallExempt`. Enforcement went into the
 * eight files that remembered, `/vehicle-setup` forgot, and a fully blocked
 * account could still edit vehicles. Nobody found out by reading the code —
 * you had to enumerate the routes.
 *
 * So the web-off gate is enforced structurally from the start. Add a page, and
 * either it awaits `requireWebAccess()` or this test names it and fails. There
 * is no third state where a route is quietly ungated, which is the only version
 * of "the web is off" worth claiming.
 *
 * A route tree walk rather than a hardcoded list, for the same reason
 * `fixtureDrift` reads the schema: the filesystem already knows what the routes
 * are, and a list maintained by hand is a list that goes stale silently.
 */

const ROOT = join(__dirname, '..', '..');
const APP = join(ROOT, 'src/app');

function pageRoutes(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) pageRoutes(full, acc);
    else if (entry === 'page.tsx') acc.push(relative(ROOT, full));
  }
  return acc;
}

/**
 * Pages that must NOT call the gate, each with the reason.
 *
 * Everything here is reachable with the web switched off, which means every
 * entry is a decision with a consequence — three of them are URLs typed into
 * App Store Connect and the Google Cloud console.
 */
const UNGATED: Record<string, string> = {
  'src/app/(legal)/privacy/page.tsx': 'submitted to Apple App Review and Google brand verification; fetched anonymously',
  'src/app/(legal)/terms/page.tsx': 'same — the URL is in App Store Connect',
  'src/app/(legal)/support/page.tsx': 'the contact route a reviewer uses',
  'src/app/get-the-app/page.tsx': 'IS the screen the gate redirects to — gating it would loop',
  'src/app/login/page.tsx': 'the admin has to be able to sign in',
  'src/app/login/verify/page.tsx': 'second half of signing in',
};

describe('web-off gate covers every page', () => {
  const routes = pageRoutes(APP);

  it('found a plausible number of routes (the walk itself works)', () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it('every page either calls requireWebAccess() or is listed as deliberately open', () => {
    const missing = routes.filter((r) => {
      if (r in UNGATED) return false;
      return !readFileSync(join(ROOT, r), 'utf8').includes('requireWebAccess()');
    });

    expect(
      missing,
      `These pages do not call requireWebAccess() and are not on the ungated list:\n` +
        missing.map((r) => `  - ${r}`).join('\n') +
        `\n\nWith the web app switched off they would render to anybody holding any ` +
        `session cookie. Add \`await requireWebAccess()\` as the first statement, or add ` +
        `the route to UNGATED in this file with the reason it must stay open.`
    ).toEqual([]);
  });

  it('the ungated list has no stale entries', () => {
    const stale = Object.keys(UNGATED).filter((r) => !routes.includes(r));
    expect(stale, `UNGATED names pages that no longer exist: ${stale.join(', ')}`).toEqual([]);
  });

  /**
   * The gate has to be the FIRST thing the page does. A page that fetches a
   * trip and then checks access has already done the database work, and — worse
   * — a `notFound()` or a throw on the way there is an information leak about
   * which trip ids exist.
   */
  it('calls the gate before doing any work', () => {
    const late: string[] = [];
    for (const r of routes) {
      if (r in UNGATED) continue;
      const body = readFileSync(join(ROOT, r), 'utf8');
      const fn = body.indexOf('export default async function');
      // The BODY's opening brace, not the first `{` after the keyword — six of
      // these pages destructure `{ params, searchParams }` in the signature,
      // and the naive scan landed inside the parameter list. That produced six
      // false failures on this test's first run, which is the same lesson the
      // fixture-drift guard learned: a guard that reports the innocent gets
      // skimmed.
      let depth = 0;
      let i = body.indexOf('(', fn);
      for (; i < body.length; i++) {
        if (body[i] === '(') depth++;
        else if (body[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const brace = body.indexOf('{', i);
      const gate = body.indexOf('await requireWebAccess()', brace);
      const between = body.slice(brace, gate);
      // Comments are fine before it; statements are not.
      const code = between.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (code.replace(/^\{/, '').trim().length > 0) late.push(r);
    }
    expect(late, `The gate is not the first statement in:\n${late.map((r) => `  - ${r}`).join('\n')}`).toEqual([]);
  });
});
