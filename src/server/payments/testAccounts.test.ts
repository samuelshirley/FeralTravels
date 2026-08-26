import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// The module reaches the database at import time through the drizzle client;
// none of these tests touch it, they exercise the address boundary only.
vi.mock('@/server/db/client', () => ({ db: {} }));

import { assertTestAddress, generateTestEmail, NotATestAccountError } from './testAccounts';

/**
 * The address pattern is the whole security boundary of the admin test-account
 * tools, and one path — the `resend` action — reaches `sendOtpCode` directly
 * and RETURNS the code it generates. If that assert is ever removed, an admin
 * could type any user's address and be handed a working sign-in code for their
 * account. These tests exist to make that removal loud.
 */
describe('assertTestAddress', () => {
  it('accepts a generated test address', () => {
    const email = generateTestEmail(new Date('2026-08-26T12:00:00Z'));
    expect(email).toMatch(/^sam\+trial-260826-[0-9a-f]{4}@feraltravels\.com$/);
    expect(assertTestAddress(email)).toBe(email);
  });

  it('generates a distinct address each time', () => {
    const now = new Date('2026-08-26T12:00:00Z');
    // Two creations in the same minute must not collide into one account —
    // that is the failure that silently reuses an aged account and makes the
    // paywall untestable.
    const seen = new Set(Array.from({ length: 50 }, () => generateTestEmail(now)));
    expect(seen.size).toBeGreaterThan(45);
  });

  it('refuses every address that is not one of ours', () => {
    for (const addr of [
      'samuelashirley@gmail.com', // the author's real account
      'sam@feraltravels.com', // the real mailbox
      'sam+notes@feraltravels.com', // a different plus-tag
      'robingockert97@gmail.com', // a real user
      'sam+trial-a@feraltravels.com.evil.com', // lookalike domain
      'sam+trial-a@notferaltravels.com',
      'sam+trial-@feraltravels.com', // empty tag
      '',
    ]) {
      expect(() => assertTestAddress(addr), `${addr} must be refused`).toThrow(
        NotATestAccountError
      );
    }
  });

  it('normalises case and whitespace, because a pasted address carries both', () => {
    expect(assertTestAddress('  SAM+Trial-AB12@FeralTravels.com ')).toBe(
      'sam+trial-ab12@feraltravels.com'
    );
  });
});
