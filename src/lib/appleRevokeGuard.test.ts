import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every account deletion revokes Sign in with Apple. Decision D11.
 *
 * App Review 5.1.1(v) requires an app offering Sign in with Apple to revoke
 * the user's tokens through Apple's REST API when they delete their account.
 * The revoke lives in `src/server/deleteAccount.ts`, wrapped around the
 * `deleteUserAccount` transaction. The way to lose it is not to delete that
 * code — it is to write a second delete path (an admin "delete user" button,
 * a cleanup script) that calls `deleteUserAccount` directly, which works, and
 * erases the `accounts` rows holding the only copy of the token. After that
 * nothing can revoke it, ever.
 *
 * So: `deleteUserAccount` has exactly one caller, that caller revokes after
 * it deletes, and the route users hit goes through it. Source-level, like
 * the other guards here — the thing being checked is an import graph.
 */

const ROOT = join(__dirname, '..', '..');
const DEFINED_IN = 'src/server/repos/accountDeletion.ts';
const WRAPPER = 'src/server/deleteAccount.ts';
const ROUTE = 'src/app/api/me/delete/route.ts';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Comments removed, so a tombstone comment naming the function is not a call. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('account deletion revokes Sign in with Apple', () => {
  it('deleteUserAccount is called only by deleteAccount.ts', () => {
    const files = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'scripts'))];
    // Guards the guard: a walk that found nothing would pass vacuously.
    expect(files.length).toBeGreaterThan(100);

    const callers = files
      .map((f) => relative(ROOT, f))
      .filter((rel) => rel !== DEFINED_IN)
      .filter((rel) => /\bdeleteUserAccount\b/.test(code(read(rel))));
    expect(
      callers,
      'Delete through deleteAccount() in src/server/deleteAccount.ts. Calling deleteUserAccount ' +
        "directly erases the user's Apple refresh token without revoking it (App Review 5.1.1(v)).",
    ).toEqual([WRAPPER]);
  });

  it('deleteAccount.ts reads the tokens, deletes, then revokes — in that order', () => {
    const src = code(read(WRAPPER));
    expect(src).toMatch(/\brevokeRefreshToken\s*\(/);
    expect(src).toMatch(/\bgetAppleRefreshTokens\s*\(/);

    const body = src.slice(src.indexOf('export async function deleteAccount'));
    const readAt = body.search(/\.readTokens\s*\(/);
    const deleteAt = body.search(/\.deleteUser\s*\(/);
    const revokeAt = body.search(/\.revoke\s*\(/);
    expect(readAt, 'deleteAccount must read the Apple tokens').toBeGreaterThan(-1);
    expect(deleteAt, 'deleteAccount must delete').toBeGreaterThan(readAt);
    expect(revokeAt, 'deleteAccount must revoke AFTER the delete commits').toBeGreaterThan(deleteAt);
  });

  it('the delete route goes through deleteAccount', () => {
    const src = code(read(ROUTE));
    expect(src).toMatch(/import\s*\{\s*deleteAccount\s*\}\s*from\s*'@\/server\/deleteAccount'/);
    expect(src).toMatch(/\bdeleteAccount\s*\(/);
  });

  it('the app forwards the Apple authorization code — without it there is nothing to revoke', () => {
    const oauth = code(read('mobile/lib/oauth.ts'));
    expect(oauth).toMatch(/credential\.authorizationCode/);
    expect(oauth).toMatch(/exchangeWithRetry\(\{ provider: "apple",[^}]*\bauthorizationCode\b/);
  });
});
