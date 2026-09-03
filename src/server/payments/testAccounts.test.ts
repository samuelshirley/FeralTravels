import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// The module reaches the database at import time through the drizzle client;
// none of these tests touch it, they exercise the address boundary only.
vi.mock('@/server/db/client', () => ({ db: {} }));
// The repo modules reach Auth.js, and next 14 ships no `./server` export map,
// so an extensionless `next/server` import inside next-auth cannot resolve
// under vitest. None of these tests call into the repos — they exercise the
// address boundary — so the cheapest correct thing is to keep that chain out
// of the graph entirely.
vi.mock('@/server/repos/trips', () => ({ cloneTrip: vi.fn(), createTrip: vi.fn() }));
vi.mock('@/server/repos/vehicles', () => ({ addVehicle: vi.fn() }));

import {
  assertTestAddress,
  generateTestEmail,
  NotATestAccountError,
  seedTranscript,
} from './testAccounts';
import { seededTripStartISO } from '@/app/api/test/seedDates';
import { TRIP_INTENT_QUESTION } from '@/server/onboarding';

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


/**
 * The seeded transcript, and the one rule it has: no written calendar date.
 *
 * This is the guard for a real report. The fixture used to CLONE the source
 * trip's chat rows, so a generated account arrived with a conversation about
 * the day the admin happened to plan their own trip — "setting off Tue 18 Aug",
 * "change this trip to me leaving on September 15th" — sitting above an
 * itinerary the same function had just re-dated to today + 14. It was read,
 * reasonably, as the seeded dates being wrong. They were not; the transcript
 * was, and it got wronger every day the fixture went untouched.
 *
 * `seedDates.ts` already argues at length that a fixture must never contain a
 * written date. That argument was only ever enforced for the trip's OWN dates.
 * These tests extend it to the words on screen next to them.
 */
describe('seedTranscript', () => {
  const ROUTE = ['Girona', 'Salamanca', 'Porto', 'Lisbon'];

  it('dates every turn from the start it was given', () => {
    const turns = seedTranscript('trip-1', '2026-09-10', ROUTE);
    const text = turns.map((t) => t.content).join('\n');
    expect(text).toContain('Thu 10 Sep');
  });

  it('moves with the seed date rather than describing a fixed day', () => {
    const a = seedTranscript('trip-1', '2026-09-10', ROUTE).map((t) => t.content).join('\n');
    const b = seedTranscript('trip-1', '2027-03-02', ROUTE).map((t) => t.content).join('\n');
    expect(a).not.toEqual(b);
    expect(b).toContain('Tue 2 Mar');
    expect(b).not.toContain('Sep');
  });

  /**
   * The regression itself. Any month name or ISO date that is NOT derived from
   * the start we passed in is a date somebody wrote down, which is the bug.
   */
  it('contains no calendar date the caller did not supply', () => {
    const start = seededTripStartISO(new Date('2026-08-27T12:00:00Z'));
    const turns = seedTranscript('trip-1', start, ROUTE);
    // Strip the one legitimate rendering of the supplied date before sweeping.
    const supplied = new Date(`${start}T00:00:00Z`).toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
    const text = turns
      .map((t) => t.content)
      .join('\n')
      .split(supplied)
      .join('');

    expect(text).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(text).not.toMatch(
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\b/
    );
  });

  it('describes the route the trip actually has, not a hardcoded one', () => {
    const turns = seedTranscript('trip-1', '2026-09-10', ['Bilbao', 'Bordeaux']);
    const text = turns.map((t) => t.content).join('\n');
    expect(text).toContain('Bilbao');
    expect(text).toContain('Bordeaux');
    expect(text).not.toContain('Porto');
  });

  /** The UI renders this instead of the prose. A fabricated one is a lie with a table around it. */
  it('never invents a plan summary', () => {
    for (const turn of seedTranscript('trip-1', '2026-09-10', ROUTE)) {
      expect(turn.planSummary ?? null).toBeNull();
    }
  });

  it('opens with the greeting a real trip opens with', () => {
    const [first] = seedTranscript('trip-1', '2026-09-10', ROUTE);
    expect(first.role).toBe('assistant');
    expect(first.kind).toBe('form_question');
    // The CONSTANT, not a quoted fragment of it. This asserted
    // `toContain("Hi, I'm Penny")` and broke the moment the greeting was
    // rewritten — which is drift, not a regression, and exactly what the
    // test's own name says it is checking.
    expect(first.content).toContain(TRIP_INTENT_QUESTION.label);
  });
});
