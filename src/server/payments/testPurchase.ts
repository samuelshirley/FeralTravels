import 'server-only';

/**
 * The fake-purchase allowlist.
 *
 * The problem this solves: a TestFlight binary points at PRODUCTION (that is
 * the deliberate config in `mobile/eas.json`), and the E2E fixture endpoints
 * are hard-off on production with no override — correctly, and that guard is
 * not being weakened. So there has to be some way for the author to walk the
 * paywall end-to-end on a real device against the real API before Apple's
 * paperwork is done.
 *
 * The shape of the answer matters. This is NOT a flag the client sets, not a
 * build variant, and not an env var that turns the feature on globally. It is
 * an explicit list of email addresses, read server-side, defaulting to EMPTY.
 * An unset env var grants nothing to nobody. The client is told whether it may
 * show the button, and the endpoint re-checks anyway — a client that lies
 * about being allowlisted gets a 403.
 *
 * Every grant made this way is written to `subscription_events` with
 * `source: 'fake'`, so a subscription that was never paid for can always be
 * told apart from one that was, months later, by anyone reading the table.
 */
function allowSet(): Set<string> {
  const raw = process.env.SUBSCRIPTION_TEST_EMAILS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isTestPurchaseAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowSet().has(email.trim().toLowerCase());
}
