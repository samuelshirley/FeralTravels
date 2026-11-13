/**
 * No iOS shard sends more sign-in codes than one IP may send in the window.
 *
 * Each shard runs on its own simulator, so every code it sends counts against
 * ONE address's `otp_send` limit (src/lib/ipLimit.ts: 10 an hour). The 11th
 * send is refused with a 429, and the app answers ANY 429 on that screen with
 * "We already sent you a code — enter it below" — so the flow reaches the
 * code boxes with no code to read, and read-otp.js reports the row as gone.
 *
 * That is exactly how it failed (PR #98, 2026-11-02): #94 and #95 each added
 * one sign-in to the `flows` shard, which took it from 9 to 11, and
 * feature-requests.yaml, the last flow in the shard, was the 11th.
 *
 * Counted statically: a flow's sends are its `sign-in-otp.yaml` runs, followed
 * through every `runFlow`, plus any direct tap on "Email me a 6-digit code" or
 * "Resend code" outside that subflow. launch.yaml, which CI runs first in every
 * shard, is counted too.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { limitFor } from './ipLimit';
// One definition of "how many codes does this flow send", shared with CI's
// re-run decision (scripts/maestro-rerun.mjs), so the two cannot disagree.
import {
  OTP_SENDS_PER_HOUR,
  SIGN_IN_RETRY_RESERVE,
  sendsOf,
  shardFlows,
} from '../../scripts/maestro-rerun.mjs';

const DIR = path.join(process.cwd(), 'mobile', 'maestro');

/**
 * Every shard file, read from disk. It was a hand-written list, and when
 * `settings.yaml` was split out of `flows` (2026-11-12) nobody added it, so the
 * one shard nothing counted was the next one to grow (2026-11-13). `_rerun-*`
 * files are written by CI at run time and never committed.
 */
const SHARDS = readdirSync(path.join(DIR, 'shards'))
  .filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))
  .sort();
const MAX = limitFor('otp_send').max;
/** What a shard may plan for: sign-in-otp.yaml's one retry is kept in hand. */
const PLANNED = MAX - SIGN_IN_RETRY_RESERVE;

describe('Maestro sign-in code budget per shard', () => {
  it('counts what it should (the guard is not vacuous)', () => {
    expect(sendsOf('sign-in.yaml')).toBe(1);
    expect(sendsOf('sign-out.yaml')).toBe(2);
    expect(sendsOf('launch.yaml')).toBe(0);
    expect(SHARDS).toContain('settings.yaml');
    expect(OTP_SENDS_PER_HOUR, 'scripts/maestro-rerun.mjs must use the server\'s otp_send limit').toBe(MAX);
    expect(SIGN_IN_RETRY_RESERVE).toBeGreaterThan(0);
    for (const s of SHARDS) expect(shardFlows(s).length, s).toBeGreaterThan(0);
  });

  for (const shard of SHARDS) {
    it(`${shard} sends at most ${PLANNED} codes from its simulator, leaving one for sign-in's retry`, () => {
      const per = ['launch.yaml', ...shardFlows(shard)].map((f) => [f, sendsOf(f)] as const);
      const total = per.reduce((n, [, c]) => n + c, 0);
      expect(
        total,
        `${shard} sends ${total} sign-in codes (${per.filter(([, c]) => c).map(([f, c]) => `${f}:${c}`).join(', ')}); ` +
          `the server allows ${MAX} an hour per IP and sign-in-otp.yaml's retry may spend ` +
          `${SIGN_IN_RETRY_RESERVE} more. Move a flow to a shard with room.`,
      ).toBeLessThanOrEqual(PLANNED);
    });
  }
});
