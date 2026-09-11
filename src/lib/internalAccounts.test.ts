import { describe, expect, it } from 'vitest';
import { INTERNAL_EMAIL_PATTERNS, isInternalAccountEmail } from './internalAccounts';

/**
 * A fixed corpus, not a live mirror of prod: every `users.email` that existed
 * on 2026-09-10, split by hand into "ours" and "theirs", plus the shapes CI
 * mints. Real signups keep arriving, so this list is deliberately NOT asserted
 * against the live row count — it is here so a change to the patterns has to
 * face every address we have actually seen.
 */
const OURS = [
  // Our own domain, at every depth it appears at.
  'sam@feraltravels.com',
  'testing@feraltravels.com',
  'sam+trial-260827-7f9e@feraltravels.com',
  'sam+trial-260827-de78@feraltravels.com',
  'sam+trial-260910-0a55@feraltravels.com',
  'sam+trial-260910-cfc0@feraltravels.com',
  'playwright-abc123-1@e2e.feraltravels.com',
  'PLAYWRIGHT-ABC123-1@E2E.FERALTRAVELS.COM',
  // The reserved-TLD fixtures.
  'feral-e2e-fixture@feraltravels.test',
  'feral-e2e-remediation@feraltravels.test',
  // The owner's dated gmail signups — every shape he has actually used.
  'samuelashirley+11.8.26.1@gmail.com',
  'samuelashirley+11.8.26.2@gmail.com',
  'samuelashirley+15.8.26.1@gmail.com',
  'samuelashirley+20.5.26@gmail.com',
  'samuelashirley+21.5.26.1@gmail.com',
  'samuelashirley+21.5.26.2@gmail.com',
  'samuelashirley+25.5.26.1@gmail.com',
  'samuelashirley+26.6.26.1@gmail.com',
  'samuelashirley+26.6.26.3@gmail.com',
  'samuelashirley+28.8.26.1@gmail.com',
  'samuelashirley+31.5.1@gmail.com',
  'samuelashirley+4.9.26.9@gmail.com',
  'samuelashirley+6.2.26.1@gmail.com',
  'samuelashirley+8.9.26.1@gmail.com',
];

/** Real people. The owner's own gmail account is one of them. */
const THEIRS = [
  'samuelashirley@gmail.com',
  'alex.p.pradhan@gmail.com',
  'completojorge@gmail.com',
  'devereauxc4@yahoo.com',
  'emil.kuhrt@gmail.com',
  'gtrubio192@gmail.com',
  'h99@live.se',
  'ilapeikyte@gmail.com',
  'johanned@hotmail.no',
  'jtysonwilliams@gmail.com',
  'kls777@dotexamdr.com',
  'melaniepresho@hotmail.com',
  'robingockert97@gmail.com',
  'sandra.verbeck@gmail.com',
  'sbolcati25@gmail.com',
  'slrichardstx@gmail.com',
];

/**
 * THE POINT OF THE TIGHT GMAIL PATTERN.
 *
 * `samuelashirley+<anything>@gmail.com` is a PUBLIC address — anyone can sign
 * up as one and the code reaches the owner's inbox — so a flood there is
 * exactly what the count must show. Every address here is one a stranger could
 * pick, and every one has to fail the filter.
 *
 * The domain patterns are a wildcard on purpose and are NOT in this list: an
 * account on `feraltravels.com` needs a mailbox we own, so no stranger can
 * make one.
 */
const SPAM_VECTOR = [
  'samuelashirley+spam@gmail.com',
  'samuelashirley+win-a-prize@gmail.com',
  'samuelashirley+1@gmail.com',
  'samuelashirley+a@gmail.com',
  'samuelashirley+test@gmail.com',
  'samuelashirley+26.6.26.1.spam@gmail.com',
  'samuelashirley+2026-06-26@gmail.com',
  'samuelashirley+.@gmail.com',
  // Someone else's plus-address is not ours.
  'someone+26.6.26.1@gmail.com',
  // Lookalike domains — a suffix or a prefix, never a match. The repo's own
  // fixtures use `notferaltravels.com` and `feraltravels.com.evil.com` as
  // adversarial cases; both must be counted as strangers.
  'sam@notferaltravels.com',
  'sam+trial-a@notferaltravels.com',
  'sam@feraltravels.com.evil.com',
  'playwright-1@e2e.feraltravels.com.evil.com',
  'samuelashirley+26.6.26.1@gmail.com.evil.com',
  'feral-e2e-fixture@feraltravels.testing',
  'sam@myferaltravels.com',
];

describe('isInternalAccountEmail', () => {
  it.each(OURS)('%s is ours', (email) => {
    expect(isInternalAccountEmail(email)).toBe(true);
  });

  it.each(THEIRS)('%s is a user', (email) => {
    expect(isInternalAccountEmail(email)).toBe(false);
  });

  it.each(SPAM_VECTOR)('%s is COUNTED — a stranger could sign up with it', (email) => {
    expect(isInternalAccountEmail(email)).toBe(false);
  });

  it('treats a missing email as a user, not as ours', () => {
    expect(isInternalAccountEmail(null)).toBe(false);
    expect(isInternalAccountEmail(undefined)).toBe(false);
    expect(isInternalAccountEmail('')).toBe(false);
  });

  it('lists every address exactly once across the three corpora', () => {
    // A duplicate across the lists would mean the split is undecided, and one
    // `it.each` block would be asserting the opposite of another.
    const all = [...OURS, ...THEIRS, ...SPAM_VECTOR];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('INTERNAL_EMAIL_PATTERNS', () => {
  it('is anchored at both ends — an unanchored pattern matches a lookalike domain', () => {
    for (const p of INTERNAL_EMAIL_PATTERNS) {
      expect(p.startsWith('^')).toBe(true);
      expect(p.endsWith('$')).toBe(true);
    }
  });

  it('stays inside the syntax Postgres and JS agree on', () => {
    // The same sources are handed to Postgres as `~*`. Anything outside this
    // subset risks the SQL count and the JS predicate disagreeing, which is a
    // bug that only shows up as a number being quietly wrong.
    for (const p of INTERNAL_EMAIL_PATTERNS) {
      expect(p).toMatch(/^[\w@.+^$|()?*{}[\]\\,-]+$/);
      // No lazy quantifiers, no lookaround, no backreferences.
      expect(p).not.toMatch(/\(\?|\\[0-9]|[*+?]\?/);
    }
  });

  it('has no wildcard on the public gmail address', () => {
    // The regression guard for the whole file. A wildcard is safe over a
    // namespace we control and never over gmail's, so this one pattern may not
    // grow a `.*` / `.+` after the plus sign.
    const gmail = INTERNAL_EMAIL_PATTERNS.find((p) => p.includes('samuelashirley'));
    expect(gmail).toBeDefined();
    expect(gmail).not.toMatch(/\.[*+]/);
  });

  it('does not treat a domain that merely CONTAINS ours as ours', () => {
    // `([a-z0-9-]+\.)*` must require a dot separator, or `notferaltravels.com`
    // and `myferaltravels.com` — domains anyone can register — become ours.
    expect(isInternalAccountEmail('x@notferaltravels.com')).toBe(false);
    expect(isInternalAccountEmail('x@myferaltravels.com')).toBe(false);
    expect(isInternalAccountEmail('x@e2e.feraltravels.com')).toBe(true);
  });
});
