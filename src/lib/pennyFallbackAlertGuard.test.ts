import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "Sorry, I couldn't apply that cleanly" must reach Sam when a user gets it.
 * The alert is three hops — claude.ts records the fallback on the turn's
 * result, the replan route passes it to reportPennyFallback — and dropping any
 * one hop silently stops the email while every unit test still passes.
 */
const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('a fallback reply is always recorded and alerted', () => {
  const claude = read('src/lib/claude.ts');
  const route = read('src/app/api/trip/replan/route.ts');

  it('claude.ts builds the fallback record where it writes the fallback reply', () => {
    const reply = claude.indexOf(`: "Sorry, I couldn't apply that cleanly`);
    const record = claude.indexOf('fallbackInfo = pennyFallbackFor(');
    expect(reply, 'fallback reply text').toBeGreaterThan(-1);
    expect(record, 'pennyFallbackFor call').toBeGreaterThan(-1);
    // Same branch: the record is built within a few lines of the reply.
    expect(Math.abs(record - reply)).toBeLessThan(1500);
  });

  it("the turn's result carries it", () => {
    expect(claude).toMatch(/fallback: fallbackInfo,/);
  });

  it('the replan route reports it', () => {
    expect(route).toMatch(/if \(final\.fallback\) \{\s*await reportPennyFallback\(\{ userId, tripId, fallback: final\.fallback \}\);/);
  });
});
