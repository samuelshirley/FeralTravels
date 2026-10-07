import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every API handler asks who is calling before it does anything, and every
 * handler addressed by an id checks that the caller may touch THAT id.
 *
 * Read per exported handler, not per file: a file whose GET is guarded and
 * whose DELETE is not would pass a whole-file grep. A handler exported in a
 * shape this test cannot read fails, so nothing slips past by being unusual.
 *
 * The behaviour behind each rule is proven over HTTP in
 * e2e/api-contracts.spec.ts (anonymous → 401, stranger → 403/404). This is the
 * cheap tripwire that stops a new route shipping without the call at all.
 */

const API_DIR = path.join(__dirname, '..', 'app', 'api');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** A call that establishes who the caller is (or refuses them). */
const AUTH_GUARD =
  /\b(requireUserId|requireUser|requireAdmin|requireEntitledUser|isTestRequestAuthorized)\(/;

/** A call that checks the caller may touch the addressed row. */
const OWNERSHIP_CHECK = /\b(assert[A-Z][A-Za-z]*OwnedByUser|assertTripReadableByUser)\(/;

/**
 * Routes that do not call an AUTH_GUARD, each with its reason and the marker
 * that must be present in the handler instead — the exemption is not a free
 * pass, it names what guards the route.
 */
const PUBLIC: Record<string, { reason: string; marker: RegExp }> = {
  'auth/[...nextauth]': {
    reason: 'Auth.js itself: the web OAuth callbacks and sign-out',
    marker: /export const \{ GET, POST \} = handlers;/,
  },
  'mobile/oauth/exchange': {
    reason: 'pre-sign-in: verifies a provider ID token against its JWKS',
    marker: /await consumeIdToken\(/,
  },
  'mobile/otp/send': {
    reason: 'pre-sign-in: sends the code; IP- and address-throttled',
    marker: /await assertIpAllowed\('otp_send'/,
  },
  'mobile/otp/verify': {
    reason: 'pre-sign-in: checks the code, attempt-limited',
    marker: /await signInWithOtpCore\(/,
  },
  'webhooks/revenuecat': {
    reason: 'RevenueCat server-to-server, shared secret compared in constant time',
    marker: /timingSafeEqual\(a, b\)/,
  },
  'admin/test-error': {
    reason: 'admin-only drill; answers 404 (not 401/403) to anyone else',
    marker: /isAdmin\(session\.user\.email\)/,
  },
};

/**
 * [id] routes that scope by user inside the repo instead of an assert. The
 * marker is the user-scoped call shape every handler must use.
 */
const USER_SCOPED_REPO: Record<string, { reason: string; marker: RegExp }> = {
  'vehicles/[id]': {
    reason: 'every vehicles repo call takes (userId, id) and matches on both',
    marker: /\w+\(userId, id(, \w+)?\)/,
  },
};

type Handler = { route: string; method: string; body: string };

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

function routeName(file: string): string {
  return path.relative(API_DIR, path.dirname(file)).split(path.sep).join('/');
}

/**
 * Source with comments removed, so a comment that MENTIONS `requireUser()`
 * cannot stand in for the call (it did, in support/route.ts, until the
 * mutation check caught it).
 */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Body of `export async function METHOD(` up to the next top-level export. */
function handlersOf(file: string): Handler[] {
  const src = code(file);
  const route = routeName(file);
  const found: Handler[] = [];
  for (const method of METHODS) {
    const fn = new RegExp(`^export (async )?function ${method}\\(`, 'm').exec(src);
    if (fn) {
      const rest = src.slice(fn.index + fn[0].length);
      const next = /^export /m.exec(rest);
      found.push({ route, method, body: next ? rest.slice(0, next.index) : rest });
      continue;
    }
    // Any other way of exporting a handler is accepted only for the Auth.js
    // re-export, which the PUBLIC marker pins exactly.
    const other = new RegExp(`^export [^\\n]*\\b${method}\\b`, 'm').exec(src);
    if (other) found.push({ route, method, body: other[0] });
  }
  return found;
}

/**
 * A handler may delegate to a same-file helper; follow one level of plain
 * function calls so `return handle(req)` is read as what `handle` does.
 */
function withLocalHelpers(file: string, body: string): string {
  const src = code(file);
  let out = body;
  for (const m of body.matchAll(/\b([a-z][A-Za-z0-9]*)\(/g)) {
    const def = new RegExp(`^(async )?function ${m[1]}\\(`, 'm').exec(src);
    if (!def) continue;
    const rest = src.slice(def.index);
    const end = /^}/m.exec(rest);
    out += '\n' + (end ? rest.slice(0, end.index) : rest);
  }
  return out;
}

const files = routeFiles(API_DIR);
const handlers = files.flatMap(handlersOf);

describe('routeAuthGuard', () => {
  it('finds the routes it is checking', () => {
    expect(files.length).toBeGreaterThan(60);
    expect(handlers.length).toBeGreaterThan(files.length);
  });

  it('every route exports at least one handler this test can read', () => {
    const empty = files.filter((f) => handlersOf(f).length === 0).map(routeName);
    expect(empty).toEqual([]);
  });

  it('every non-public handler calls an auth guard', () => {
    const missing = handlers
      .filter((h) => !PUBLIC[h.route])
      .filter((h) => !AUTH_GUARD.test(withLocalHelpers(path.join(API_DIR, h.route, 'route.ts'), h.body)))
      .map((h) => `${h.method} /api/${h.route}`);
    expect(missing, 'add requireUserId/requireUser/requireAdmin/requireEntitledUser, or a PUBLIC entry with its reason').toEqual([]);
  });

  it('every PUBLIC exemption still carries the thing that guards it', () => {
    const broken = Object.entries(PUBLIC)
      .filter(([route, { marker }]) => {
        const file = path.join(API_DIR, route, 'route.ts');
        return !fs.existsSync(file) || !marker.test(code(file));
      })
      .map(([route]) => route);
    expect(broken).toEqual([]);
  });

  it('every handler addressed by an [id] checks ownership of that id', () => {
    const missing = handlers
      .filter((h) => /\[[A-Za-z]*[iI]d\]/.test(h.route))
      .filter((h) => {
        const body = withLocalHelpers(path.join(API_DIR, h.route, 'route.ts'), h.body);
        if (OWNERSHIP_CHECK.test(body)) return false;
        const scoped = USER_SCOPED_REPO[h.route];
        return !(scoped && scoped.marker.test(body));
      })
      .map((h) => `${h.method} /api/${h.route}`);
    expect(missing, 'call an assert*OwnedByUser, or a user-scoped repo listed in USER_SCOPED_REPO').toEqual([]);
  });

  it('every guarded handler has a row in the HTTP contract table (e2e/api-contracts.spec.ts)', () => {
    const spec = fs.readFileSync(path.join(__dirname, '..', '..', 'e2e', 'api-contracts.spec.ts'), 'utf8');
    const missing = handlers
      .filter((h) => !PUBLIC[h.route] && !h.route.startsWith('test/'))
      .map((h) => `${h.method} ${h.route}`)
      .filter((key) => !spec.includes(`'${key}'`));
    expect(missing, 'add a CASES row: anonymous, malformed and stranger refusals').toEqual([]);
  });

  it('no exemption list names a route that no longer exists', () => {
    const names = new Set(files.map(routeName));
    const stale = [...Object.keys(PUBLIC), ...Object.keys(USER_SCOPED_REPO)].filter((r) => !names.has(r));
    expect(stale).toEqual([]);
  });
});
