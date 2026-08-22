/**
 * Every error code the native OAuth exchange can return must have copy in the
 * app, or the user gets "Something went wrong. Please try again."
 *
 * This is not hypothetical. `TokenAlreadyUsed` shipped in PR #7 as a brand-new
 * 401 from oauthReplay.ts and was never added to `ERROR_COPY`, so the one
 * failure a user can actually recover from — tap the button again — read as an
 * unexplained crash. `RateLimited` was worse than unmapped: it was mapped to
 * the OTP wording ("a code was already sent recently, wait 60 seconds") and
 * shown to someone who had just tapped Continue with Google and was not
 * waiting for any email.
 *
 * Source-level scanning, like the other guards in this directory: the codes
 * are string literals on both sides of an HTTP boundary, so there is no type
 * that could connect them. A regex over the two files is the only thing that
 * can, and it fails at the moment the code is added rather than on a tester's
 * phone.
 *
 * Adding a new code? Add it to ERROR_COPY (or OAUTH_ERROR_COPY when the
 * wording only makes sense there) and this test goes green again.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** Everything in the exchange's call chain that can produce an `error` code. */
const SERVER_FILES = [
  'src/app/api/mobile/oauth/exchange/route.ts',
  'src/server/auth/oauthIdentity.ts',
  'src/server/auth/oauthReplay.ts',
];

const SIGN_IN = 'mobile/app/sign-in.tsx';

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Codes are thrown three ways: `new UnauthorizedError('X')`,
 * `new HttpError(429, 'X')`, and the route's own `{ error: 'X' }`. Anything
 * with a space is prose for a human, not a code — `errorResponse` passes those
 * through and `messageFor` shows them verbatim.
 */
function serverErrorCodes(): string[] {
  const codes = new Set<string>();
  const patterns = [
    /new\s+UnauthorizedError\(\s*'([^']+)'/g,
    /new\s+ForbiddenError\(\s*'([^']+)'/g,
    /new\s+HttpError\(\s*\d{3}\s*,\s*'([^']+)'/g,
    /error:\s*'([^']+)'/g,
  ];
  for (const rel of SERVER_FILES) {
    const source = read(rel);
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const code = match[1];
        if (!code.includes(' ')) codes.add(code);
      }
    }
  }
  return [...codes].sort();
}

/** Pull the keys out of a `const NAME: Record<string, string> = { ... };` literal. */
function copyKeys(source: string, constName: string): string[] {
  const start = source.indexOf(`const ${constName}: Record<string, string> = {`);
  expect(start, `${constName} not found in ${SIGN_IN}`).toBeGreaterThan(-1);
  const end = source.indexOf('\n};', start);
  expect(end, `${constName} has no closing brace`).toBeGreaterThan(start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*):/gm)].map((m) => m[1]);
}

/**
 * Read the value of one key out of such a literal. Values wrap across lines
 * and Prettier decides where, so the string parts are joined rather than
 * matched as one literal.
 */
function copyValue(source: string, constName: string, key: string): string {
  const start = source.indexOf(`const ${constName}: Record<string, string> = {`);
  const body = source.slice(start, source.indexOf('\n};', start));
  const entry = new RegExp(`^ {2}${key}:`, 'm').exec(body);
  expect(entry, `${key} not found in ${constName}`).not.toBeNull();
  const from = (entry as RegExpExecArray).index + (entry as RegExpExecArray)[0].length;
  const after = body.slice(from);
  const nextKey = after.search(/^ {2}[A-Za-z][A-Za-z0-9_]*:/m);
  const chunk = nextKey === -1 ? after : after.slice(0, nextKey);
  return [...chunk.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
}

describe('native sign-in error copy', () => {
  const signIn = read(SIGN_IN);
  const mapped = new Set([
    ...copyKeys(signIn, 'ERROR_COPY'),
    ...copyKeys(signIn, 'OAUTH_ERROR_COPY'),
  ]);

  it('finds the codes to check', () => {
    // Guards the guard: a regex that stopped matching would make every
    // assertion below vacuously true.
    const codes = serverErrorCodes();
    expect(codes.length).toBeGreaterThanOrEqual(5);
    expect(codes).toContain('InvalidToken');
    expect(codes).toContain('TokenAlreadyUsed');
  });

  for (const code of serverErrorCodes()) {
    it(`maps ${code} to copy the user can act on`, () => {
      expect(
        mapped.has(code),
        `${code} is returned by the exchange but has no entry in ERROR_COPY or ` +
          `OAUTH_ERROR_COPY in ${SIGN_IN}, so the app shows the generic error.`
      ).toBe(true);
    });
  }

  it('gives RateLimited different wording on the OAuth path', () => {
    // The regression this exists to stop: one code, two very different
    // situations. If these ever converge again, one of the two is lying.
    const otp = copyValue(signIn, 'ERROR_COPY', 'RateLimited');
    const oauth = copyValue(signIn, 'OAUTH_ERROR_COPY', 'RateLimited');
    expect(otp).not.toBe(oauth);
    expect(otp.toLowerCase()).toContain('code');
    expect(oauth.toLowerCase()).not.toContain('code');
  });

  it('tells a TokenAlreadyUsed user to try again rather than dead-ending', () => {
    const copy = copyValue(signIn, 'OAUTH_ERROR_COPY', 'TokenAlreadyUsed').toLowerCase();
    expect(copy).toContain('again');
  });

  it('routes OAuth failures through the OAuth-aware branch', () => {
    // A perfect OAUTH_ERROR_COPY map is worthless if runOAuth never asks for
    // it, and `context` defaults to "email" — so forgetting the argument is
    // silent. Exactly one call site passes it: the OAuth catch.
    const oauthCalls = [...signIn.matchAll(/messageFor\(err, "oauth"\)/g)];
    expect(oauthCalls).toHaveLength(1);

    // And it is the one inside runOAuth, right after the cancel check.
    const cancelCheck = signIn.indexOf('isOAuthCancelled(err)');
    expect(cancelCheck).toBeGreaterThan(-1);
    expect(signIn.slice(cancelCheck, cancelCheck + 200)).toContain('messageFor(err, "oauth")');
  });
});
