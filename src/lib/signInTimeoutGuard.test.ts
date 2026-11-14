import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The app's sign-in requests give up, and the sign-in flow tries the send
 * twice.
 *
 * Twice (2026-11-03, 2026-11-13) an iOS shard tapped "Email me a 6-digit code"
 * and "Check your email" never appeared. The server side is a few quick
 * database calls; the app's `requestOtp` had no timeout, so a request that
 * stalled left the button spinning until the app was killed. That is a real
 * person's experience on a weak signal too, not only CI's.
 *
 * Source-level, like the other mobile guards here: nothing in vitest renders
 * the native app.
 */

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const api = read('mobile/lib/api.ts');
const signIn = read('mobile/app/sign-in.tsx');
const flow = read('mobile/maestro/sign-in-otp.yaml')
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

/** The body of one exported function, up to the next top-level declaration. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`no ${name}`);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(export |function |const |\/\*\*)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

describe('the sign-in requests cannot hang', () => {
  it('requestOtp and verifyOtp both pass a timeout', () => {
    expect(fn(api, 'requestOtp')).toMatch(/timeoutMs: SIGN_IN_TIMEOUT_MS/);
    expect(fn(api, 'verifyOtp')).toMatch(/timeoutMs: SIGN_IN_TIMEOUT_MS/);
    const ms = Number(api.match(/export const SIGN_IN_TIMEOUT_MS = ([\d_]+);/)?.[1].replace(/_/g, ''));
    // Long enough for a slow network, short enough that a person is still there.
    expect(ms).toBeGreaterThanOrEqual(10_000);
    expect(ms).toBeLessThanOrEqual(30_000);
  });

  it('apiFetch aborts on the timeout, covering the body read, and says "Timeout"', () => {
    expect(api).toMatch(/controller\.abort\(\);\n\s+\}, opts\.timeoutMs\)/);
    expect(api).toMatch(/signal: controller \? controller\.signal : opts\.signal/);
    // The body is read inside the same try, before the timer is cleared.
    const tryBlock = api.slice(api.indexOf('res = await fetch(url'), api.indexOf('} finally {\n    if (timer) clearTimeout(timer);'));
    expect(tryBlock).toMatch(/text = await res\.text\(\);/);
    expect(tryBlock).toMatch(/if \(timedOut\) \{\n\s+const wrapped = new ApiError\(0, "Timeout", null\);/);
  });

  it('the sign-in screen has words for it', () => {
    const copy = signIn.slice(signIn.indexOf('const ERROR_COPY: Record<string, string> = {'));
    expect(copy.slice(0, copy.indexOf('\n};'))).toMatch(/\n\s{2}Timeout:/);
  });
});

describe('sign-in-otp.yaml retries the send once', () => {
  it('wraps the tap and the wait for the code screen in one retry', () => {
    expect(flow).toMatch(
      /- retry:\n\s+maxRetries: 1\n\s+commands:\n\s+- tapOn:\n\s+text: 'Email me a 6-digit code'\n\s+optional: true\n\s+- extendedWaitUntil:\n\s+visible: 'Check your email'/,
    );
  });

  it('nothing outside the retry taps send or waits for the code screen', () => {
    const outside = flow.replace(/- retry:\n(\s{4}.*\n|\s{6}.*\n)+/, '');
    expect(outside).not.toMatch(/Email me a 6-digit code/);
    expect(outside).not.toMatch(/Check your email/);
  });
});
