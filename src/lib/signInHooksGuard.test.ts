import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Both sign-in paths run the same hooks. Decision D4.
 *
 * There are TWO ways into this app and only one of them is an Auth.js sign-in.
 * `createSessionForEmail` (`auth/otp.ts`) serves the emailed code AND the native
 * `/api/mobile/oauth/exchange`, and Auth.js `events` never fire for it. So a
 * hook wired only into `auth/index.ts` silently does nothing for every OTP and
 * every iOS Google/Apple sign-in.
 *
 * This repo has made that mistake already — `syncCompedFlagOnSignIn` was wired
 * only to the events, leaving every native sign-in on the column default — and
 * `claimPromoOnSignIn` was written knowing it, which is why it is in both. The
 * list is here so the third hook someone adds is caught on the day.
 */

const ROOT = join(__dirname, '..', '..');
const AUTHJS = 'src/server/auth/index.ts';
const SESSION = 'src/server/auth/otp.ts';

/** Every hook that must run however the user got in. */
const HOOKS = ['syncAdminFlagOnSignIn', 'syncCompedFlagOnSignIn', 'claimPromoOnSignIn'];

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('sign-in hooks run on both paths', () => {
  for (const hook of HOOKS) {
    it(`${hook} is called from the Auth.js events`, () => {
      expect(read(AUTHJS)).toMatch(new RegExp(`\\b${hook}\\s*\\(`));
    });

    it(`${hook} is called from createSessionForEmail (OTP + native OAuth)`, () => {
      const src = read(SESSION);
      expect(
        new RegExp(`\\b${hook}\\s*\\(`).test(src),
        `${hook} is missing from ${SESSION}. Auth.js events do NOT fire for OTP or ` +
          `the native OAuth exchange, so a hook wired only to index.ts is dead for both.`,
      ).toBe(true);
    });
  }

  it('no hook is silently allowed to fail the sign-in', () => {
    // Bookkeeping must never be a reason somebody cannot get into the app.
    for (const rel of [AUTHJS, SESSION]) {
      const src = read(rel);
      for (const hook of HOOKS) {
        const at = src.indexOf(`${hook}(`);
        if (at === -1) continue;
        expect(src.slice(at, at + 200), `${rel}: ${hook} should be .catch()-ed`).toMatch(
          /\.catch\(/,
        );
      }
    }
  });
});
