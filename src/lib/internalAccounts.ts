/**
 * Which accounts are OURS — anything on a domain we control, plus the owner's
 * own dated signups — and therefore not users, for the purposes of counting
 * users.
 *
 * "Total users" read 38 on 2026-09-10, of which 22 were these. The number on
 * the card is supposed to answer "how many people have signed up", and it was
 * off by more than half.
 *
 * THE TWO HALVES OF THIS LIST ARE TIGHT FOR OPPOSITE REASONS, and confusing
 * them is how this filter goes wrong:
 *
 *   - `feraltravels.com` (and `.test`) can be a WILDCARD safely, because
 *     signing up requires receiving a one-time code at the address. We own the
 *     domain and its mailboxes, so a stranger cannot get mail there, which
 *     means no stranger can create an account on it. Every row is ours by
 *     construction.
 *
 *   - `samuelashirley+…@gmail.com` can NOT. Gmail plus-addressing is PUBLIC:
 *     anyone can sign up as `samuelashirley+win@gmail.com` and the code
 *     reaches the owner's inbox, so those addresses are exactly as
 *     stranger-reachable as any other. A wildcard there would make a signup
 *     flood — the thing most worth noticing — invisible on the dashboard. So
 *     that pattern matches the dated shape the owner actually uses
 *     (`+26.6.26.1`) and nothing else; `+win` is a stranger and gets counted.
 *
 * The general rule, when adding a pattern: a wildcard is only safe over a
 * namespace we CONTROL. Over one anybody can write into, enumerate the shape.
 *
 * The failure directions are not symmetric either:
 *   - Too tight → one of our own rows shows up in the count. Visible, and
 *     someone notices the number is a couple higher than it should be.
 *   - Too loose → a real signup is hidden from the count forever. Invisible,
 *     and nobody ever notices.
 * When in doubt, leave it out of this list.
 *
 * Nothing here HIDES a row: `getAdminOverview` also returns how many were
 * excluded and the dashboard prints it, so a pattern that starts matching real
 * people moves a visible number. The user list and the spend tables are
 * unfiltered by design.
 *
 * This is deliberately NOT `isCompedEmail` / `FIXTURE_EMAIL_PATTERN` /
 * `TEST_PURCHASE_EMAIL_PATTERN`. Those are security boundaries — they decide
 * who gets free access or a fake purchase, and are kept narrow on purpose.
 * This is a reporting filter and is broader than all three.
 */

/**
 * Regex sources, matched case-insensitively, anchored, and shared by two
 * consumers: Postgres (`~*`, in `getAdminOverview`) and JS (`RegExp`, below).
 * The syntax used here — `^ $ | ( ) ? * + { } [ ] \. \+ \-` — means the same
 * thing in both engines. Keep it to that subset; anything fancier will drift
 * between the count and the predicate.
 */
export const INTERNAL_EMAIL_PATTERNS: ReadonlyArray<string> = [
  // Our own domain, at any depth: `sam@`, the `sam+trial-*` paywall accounts
  // from `scripts/make-test-user.ts`, and the per-run Playwright fixtures on
  // `e2e.feraltravels.com`. Safe as a wildcard for the reason above — an
  // account here needs a mailbox here, and we own the mailboxes.
  '^[^@]+@([a-z0-9-]+\\.)*feraltravels\\.com$',

  // Two seeded fixture rows from an earlier CI setup. `.test` is a RESERVED
  // TLD (RFC 2606) that resolves nowhere, so this is unreachable by anyone.
  '^[^@]+@feraltravels\\.test$',

  // The owner's own signups, which are always a date: +26.6.26.1, +20.5.26,
  // +31.5.1. Digits and dots ONLY — this is the public namespace, so the shape
  // is the whole defence. A signup in any other shape gets counted, which is
  // the harmless direction.
  '^samuelashirley\\+[0-9]{1,2}\\.[0-9]{1,2}\\.[0-9]{1,2}(\\.[0-9]{1,2})?@gmail\\.com$',
];

const INTERNAL_EMAIL_REGEXPS = INTERNAL_EMAIL_PATTERNS.map((p) => new RegExp(p, 'i'));

export function isInternalAccountEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return INTERNAL_EMAIL_REGEXPS.some((re) => re.test(email.trim()));
}
