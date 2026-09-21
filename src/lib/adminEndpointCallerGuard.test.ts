import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every admin endpoint that changes something has a control that calls it.
 *
 * `POST /api/admin/paywall` shipped on 2026-09-02 as the deployment-wide
 * paywall switch — moved out of Vercel because "a switch whose entire purpose
 * is being flipped back in a hurry cannot take a build" — and nothing in `src/`
 * called it. `/admin` rendered the state as an inert pill, so the only way to
 * flip it was a fetch typed into devtools. The endpoint was tested, logged and
 * correct; it just had no button.
 *
 * That is the class this guards: an admin write with no control. The admin
 * guards are cookie-only and reject bearer tokens (`requireAdmin()`), so the
 * mobile app can never be the caller — if nothing under `src/` calls it, nobody
 * can press it.
 *
 * A SET RELATION, NOT A STRING MATCH. `/api/admin/paywall` is named in
 * comments in `switch.ts` and in the route's own docstring, which is exactly
 * why a grep for the path would have passed the day this bug shipped. Only the
 * literal first argument of a `fetch(` / `apiFetch(` call counts as a caller.
 * `${...}` in a template becomes a one-segment wildcard, so
 * `/api/admin/subscription/${mode}` covers both `revoke` and `reactivate`.
 */

const ROOT = join(__dirname, '..', '..');
const ADMIN_API = join(ROOT, 'src', 'app', 'api', 'admin');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** `/api/admin/…` paths whose `route.ts` exports a POST handler. `[id]` stays as-is. */
function postRoutes(): string[] {
  return walk(ADMIN_API)
    .filter((f) => f.endsWith(`${sep}route.ts`))
    .filter((f) => /export\s+(async\s+function|const)\s+POST\b/.test(readFileSync(f, 'utf8')))
    .map((f) => '/' + relative(join(ROOT, 'src', 'app'), f).split(sep).slice(0, -1).join('/'))
    .sort();
}

/** Every `/api/admin/…` path passed literally to `fetch(` or `apiFetch(`, query stripped. */
function calledPaths(source: string): string[] {
  const call = /\b(?:fetch|apiFetch)(?:<[^>]*>)?\(\s*(['"`])(\/api\/admin\/[^'"`]*)\1/g;
  return [...source.matchAll(call)].map((m) =>
    m[2].split('?')[0].replace(/\$\{[^}]*\}/g, '*').replace(/\/$/, ''),
  );
}

/** Does a called path reach this route? `*` and `[param]` each match exactly one segment. */
function reaches(called: string, route: string): boolean {
  const a = called.split('/');
  const b = route.split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === b[i] || seg === '*' || /^\[.+\]$/.test(b[i]));
}

function uncalled(routes: string[], called: string[]): string[] {
  return routes.filter((r) => !called.some((c) => reaches(c, r)));
}

describe('every /api/admin/* write has a caller in src/', () => {
  const routes = postRoutes();

  it('finds the admin write routes (the guard is not vacuous)', () => {
    expect(routes).toContain('/api/admin/paywall');
    expect(routes).toContain('/api/admin/paywall/user');
    expect(routes.length).toBeGreaterThanOrEqual(8);
  });

  it('no POST route is a control nobody can press', () => {
    const called = walk(join(ROOT, 'src'))
      .filter((f) => !f.startsWith(ADMIN_API))
      .flatMap((f) => calledPaths(readFileSync(f, 'utf8')));
    expect(
      uncalled(routes, called),
      'An admin endpoint with no caller in src/ can only be used from devtools. ' +
        'Add the control, or delete the endpoint.',
    ).toEqual([]);
  });

  it('a path named only in a comment or a string does not count as a caller', () => {
    const called = calledPaths(
      [
        '// POST /api/admin/paywall flips the switch',
        "const doc = 'see /api/admin/paywall';",
        "await fetch('/api/admin/promo', { cache: 'no-store' });",
        'await fetch(`/api/admin/subscription/${mode}`, { method: "POST" });',
        'await apiFetch(`/api/admin/test-error?kind=${kind}`);',
      ].join('\n'),
    );
    expect(called).toEqual([
      '/api/admin/promo',
      '/api/admin/subscription/*',
      '/api/admin/test-error',
    ]);
    expect(
      uncalled(
        ['/api/admin/paywall', '/api/admin/promo', '/api/admin/subscription/revoke'],
        called,
      ),
    ).toEqual(['/api/admin/paywall']);
  });
});
