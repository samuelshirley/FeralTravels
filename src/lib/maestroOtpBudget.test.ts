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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { limitFor } from './ipLimit';

const DIR = path.join(process.cwd(), 'mobile', 'maestro');
const SEND_FLOW = 'sign-in-otp.yaml';
const SEND_TAP = /^- tapOn:\s*'(Email me a 6-digit code|Resend code)'/gm;

function live(file: string): string {
  return readFileSync(path.join(DIR, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

function subflows(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^- runFlow:\s*(\S+\.yaml)\s*$/gm)) out.push(m[1]);
  for (const m of src.matchAll(/^- runFlow:\s*\n\s+file:\s*(\S+\.yaml)\s*$/gm)) out.push(m[1]);
  return out;
}

/** Sign-in codes one run of `file` sends. */
export function sendsOf(file: string, seen: string[] = []): number {
  if (file === SEND_FLOW) return 1;
  if (seen.includes(file)) throw new Error(`runFlow cycle: ${[...seen, file].join(' → ')}`);
  const src = live(file);
  let n = [...src.matchAll(SEND_TAP)].length;
  for (const sub of subflows(src)) n += sendsOf(sub, [...seen, file]);
  return n;
}

function shardFlows(shard: string): string[] {
  const src = readFileSync(path.join(DIR, 'shards', shard), 'utf8');
  const block = src.split(/^executionOrder:/m)[0];
  return [...block.matchAll(/^\s+- (\S+\.yaml)\s*$/gm)].map((m) => m[1]);
}

const SHARDS = ['account.yaml', 'ai.yaml', 'core.yaml', 'flows.yaml', 'trips.yaml'];
const MAX = limitFor('otp_send').max;

describe('Maestro sign-in code budget per shard', () => {
  it('counts what it should (the guard is not vacuous)', () => {
    expect(sendsOf('sign-in.yaml')).toBe(1);
    expect(sendsOf('sign-out.yaml')).toBe(2);
    expect(sendsOf('launch.yaml')).toBe(0);
    for (const s of SHARDS) expect(shardFlows(s).length, s).toBeGreaterThan(0);
  });

  for (const shard of SHARDS) {
    it(`${shard} sends at most ${MAX} codes from its simulator`, () => {
      const per = ['launch.yaml', ...shardFlows(shard)].map((f) => [f, sendsOf(f)] as const);
      const total = per.reduce((n, [, c]) => n + c, 0);
      expect(
        total,
        `${shard} sends ${total} sign-in codes (${per.filter(([, c]) => c).map(([f, c]) => `${f}:${c}`).join(', ')}); ` +
          `the server allows ${MAX} an hour per IP. Move a flow to a shard with room.`,
      ).toBeLessThanOrEqual(MAX);
    });
  }
});
