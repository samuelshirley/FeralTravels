import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Two structural rules, both saying the same thing: a database failure must
 * never be answered as "you are signed out".
 *
 * Neither is checkable by types. The first is about the absence of a `catch`,
 * the second about which module a file imports a name from — a reviewer can
 * miss both, and both fail in a way nobody reproduces locally, because they
 * only appear when the database is unreachable.
 */

const ROOT = join(__dirname, '..', '..');

/**
 * RULE 1 — the bearer path must let a database error THROW.
 *
 * `userFromBearerToken` runs the session lookup for the iOS app. If that query
 * gains a `catch` returning null, the guard falls through to
 * `UnauthorizedError` and the route answers **401** — and `mobile/lib/api.ts`
 * calls `clearToken()` on 401, wiping the keychain. A Neon hiccup would
 * permanently sign every iOS user out of their device.
 *
 * Today it is protected only because nobody wrapped it. That accident is the
 * invariant; this test is what makes removing it loud.
 */
describe('the bearer session lookup does not swallow database errors', () => {
  const guards = readFileSync(join(ROOT, 'src/server/auth/guards.ts'), 'utf8');

  const start = guards.indexOf('async function userFromBearerToken');
  const body = guards.slice(start);
  const end = body.indexOf('\n}\n');

  it('found the function (the test is reading what it thinks it is)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(-1);
  });

  it('has no catch between the session query and the end of the function', () => {
    const fn = body.slice(0, end);
    const queryAt = fn.indexOf('await db');
    expect(queryAt, 'the session query moved — re-point this guard').toBeGreaterThan(-1);

    const afterQuery = fn.slice(queryAt);
    expect(
      afterQuery.includes('catch'),
      'A catch now wraps the bearer session lookup. Swallowing a database error ' +
        'there turns a 500 into a 401, and mobile/lib/api.ts clears the keychain ' +
        'on 401 — every iOS user gets signed out of their device by a database ' +
        'blip. Let it throw.',
    ).toBe(false);
  });
});

/**
 * RULE 2 — only the sign-in pages may use the unwrapped `rawAuth`.
 *
 * `auth()` is wrapped so it throws rather than reporting an unreachable
 * session store as `null`. `rawAuth` is the escape hatch, and it exists for
 * exactly two pages: `/login` and `/login/verify` should still render their
 * form during an outage instead of an error screen. Anywhere else it silently
 * reinstates the original bug for that one route, which is the hardest kind of
 * regression to see in review — one word changed, and the page starts logging
 * people out again when the database blinks.
 */
describe('rawAuth is confined to the sign-in pages', () => {
  const ALLOWED = new Set([
    'src/server/auth/index.ts', // defines and exports it
    'src/app/login/page.tsx',
    'src/app/login/verify/page.tsx',
  ]);

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, acc);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        acc.push(relative(ROOT, full));
      }
    }
    return acc;
  }

  const files = sourceFiles(join(ROOT, 'src'));

  it('found a plausible number of source files (the walk itself works)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no module outside the sign-in pages references rawAuth', () => {
    const offenders = files.filter(
      (f) => !ALLOWED.has(f) && readFileSync(join(ROOT, f), 'utf8').includes('rawAuth'),
    );

    expect(
      offenders,
      `These use rawAuth, which reports an unreachable session store as "signed out":\n` +
        offenders.map((f) => `  - ${f}`).join('\n') +
        `\n\nUse auth() instead. rawAuth exists only so /login and /login/verify ` +
        `can still render their form during an outage.`,
    ).toEqual([]);
  });
});
