/**
 * Promo code shape and the redemption DECISION, as pure functions.
 *
 * No `server-only`, no database, no clock of its own — `now` arrives as an
 * argument, exactly as it does in `src/server/payments/states.ts`, and for the
 * same reason: every refusal below needs a test, and a resolver that reads the
 * database can only be tested by writing rows for a moment in time.
 *
 * Mirrored into the Expo app by `scripts/sync-shared.mjs`, so the app and the
 * server normalize a typed code identically. If they disagreed, a user would
 * type something the app accepts and the server rejects, and the error would
 * look like a bad code rather than a bug.
 */

/**
 * Deliberately not the full alphabet.
 *
 * `O`/`0`, `I`/`1`/`L` and `S`/`5` are the pairs people get wrong reading a
 * code off a phone screen and typing it into another one. Dropping them costs
 * ~2 bits per character and buys back every support message that would
 * otherwise start "it says invalid code".
 *
 * `U` is out too, so no arrangement of the alphabet can spell an unfortunate
 * word into a code an admin has to send a stranger.
 */
const ALPHABET = 'ACDEFGHJKMNPQRTVWXYZ2346789';

/** Characters per group. Two groups, because three is a phone number. */
const GROUP = 4;

/** `FERAL-XXXX-XXXX`. The prefix is there so a code is recognisable out of context. */
export const PROMO_PREFIX = 'FERAL';

/**
 * The canonical form, and the ONLY form stored or compared.
 *
 * Uppercased, with every separator and space removed — a recipient pasting
 * `feral-4kqp-8xzm ` from a chat app and one carefully typing `FERAL4KQP8XZM`
 * are asking about the same code, and the database should not hold an opinion
 * about which of them typed it more neatly.
 */
export function normalizePromoCode(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** `FERAL` + 8 characters from the unambiguous alphabet, after normalizing. */
const CANONICAL = new RegExp(`^${PROMO_PREFIX}[${ALPHABET}]{${GROUP * 2}}$`);

export function isPromoCodeShape(raw: string): boolean {
  return CANONICAL.test(normalizePromoCode(raw));
}

/**
 * Display form: what the admin copies and the recipient reads.
 *
 * Hyphenated, because a 13-character run of capitals is unreadable and gets
 * transcribed wrong. `normalizePromoCode` puts it back.
 */
export function formatPromoCode(canonical: string): string {
  const body = canonical.slice(PROMO_PREFIX.length);
  return `${PROMO_PREFIX}-${body.slice(0, GROUP)}-${body.slice(GROUP)}`;
}

/**
 * Mint one, given a source of randomness.
 *
 * `randomBytes` is injected rather than imported so this file stays free of
 * `node:crypto` and can be mirrored to the Expo app — and so the test can
 * assert the mapping from bytes to characters rather than asserting that
 * random output looks random, which is not a test.
 *
 * Rejection sampling, not modulo: the alphabet has 27 characters and 256 is not
 * a multiple of 27, so `byte % 27` would make the first four characters
 * measurably likelier than the rest. It costs nothing to do correctly and a
 * biased code space is the kind of thing nobody ever goes back and checks.
 */
export function generatePromoCode(randomBytes: (n: number) => Uint8Array): string {
  const need = GROUP * 2;
  const out: string[] = [];
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  while (out.length < need) {
    // Over-draw so the common case is a single call even with a few rejections.
    for (const byte of randomBytes(need * 2)) {
      if (byte >= limit) continue;
      out.push(ALPHABET[byte % ALPHABET.length]);
      if (out.length === need) break;
    }
  }
  return PROMO_PREFIX + out.join('');
}

/** Everything the decision needs to know about a stored code. */
export interface PromoCodeFacts {
  /** Canonical, as stored. */
  code: string;
  /** The address it was minted for, lowercased. */
  email: string;
  /** Null means it never goes stale. */
  expiresAt: Date | null;
  /** Non-null means already spent. Single use, always. */
  redeemedAt: Date | null;
}

/**
 * Why a redemption was refused. The client branches on THIS, never on the
 * message — copy changes, and a client keyed to a sentence breaks silently when
 * someone rewords it. Same contract as `PAYWALL_ERROR_CODE`.
 */
export type PromoRefusal =
  /** No row answers to this code. Also what a typo looks like. */
  | 'promo_not_found'
  /** Someone has already spent it — possibly this same user, twice. */
  | 'promo_already_redeemed'
  /** Past `expiresAt`. The code was real; the window closed. */
  | 'promo_expired'
  /** Bound to a different address than the one signed in. */
  | 'promo_wrong_account'
  /**
   * They already hold a LIVE Apple subscription.
   *
   * Redeeming would overwrite it: `subscriptions` is one row per user, so the
   * `apple_iap` row would become a `promo` row while Apple carried on charging
   * them, and the next renewal webhook would land against a row that no longer
   * describes what they bought. Nothing on the redeem screen says that happens,
   * and choosing to redeem a code is not choosing to detach a subscription.
   *
   * LIVE, not merely present: a lapsed customer can still be given a plan.
   */
  | 'promo_active_subscription';

export type PromoDecision = { ok: true } | { ok: false; reason: PromoRefusal };

/**
 * The rules, in the order they are checked, and the order matters.
 *
 * WRONG ACCOUNT IS CHECKED BEFORE SPENT AND EXPIRED, deliberately. Someone
 * holding a code that is not theirs must not be able to learn, by trying it,
 * whether it has been used or when it lapsed — those answers are facts about
 * the real recipient's account. They get the same "not yours" either way. This
 * costs nothing, because a user who legitimately owns the code never sees that
 * branch at all.
 *
 * Everything here is a comparison on facts the caller supplies; the atomic
 * "claim it before anyone else does" step lives in the repo, because a pure
 * function cannot make a promise about concurrency.
 */
export function decidePromoRedemption(
  facts: PromoCodeFacts | null,
  ctx: { email: string; now: Date }
): PromoDecision {
  if (!facts) return { ok: false, reason: 'promo_not_found' };

  if (facts.email.trim().toLowerCase() !== ctx.email.trim().toLowerCase()) {
    return { ok: false, reason: 'promo_wrong_account' };
  }
  if (facts.redeemedAt !== null) return { ok: false, reason: 'promo_already_redeemed' };
  if (facts.expiresAt !== null && ctx.now.getTime() >= facts.expiresAt.getTime()) {
    return { ok: false, reason: 'promo_expired' };
  }
  return { ok: true };
}

/**
 * The two terms an admin may grant. Validated at the API boundary.
 *
 * Here rather than in `server/payments/promo.ts` because that module is
 * `server-only` and the unit project cannot import it — the same split that
 * already puts `decidePromoRedemption` in this file. Mirrored into the app with
 * the rest of it.
 */
export const PROMO_GRANT_MONTHS = [6, 12] as const;
export type PromoGrantMonths = (typeof PROMO_GRANT_MONTHS)[number];

export function isPromoGrantMonths(n: number): n is PromoGrantMonths {
  return (PROMO_GRANT_MONTHS as readonly number[]).includes(n);
}

/**
 * Add whole months to a date, clamped to the end of the target month.
 *
 * `setUTCMonth` alone rolls over: 31 August + 6 months is 31 February, which
 * JavaScript silently turns into 3 March. Clamping to 28 February is the
 * boring, expected answer, and it is the one an admin explaining a date to a
 * recipient would give.
 *
 * UTC throughout, deliberately. The stored `current_period_end` is a UTC
 * instant and the server runs in UTC; doing this in local time would make a
 * developer's laptop mint a term an hour different from production's.
 */
export function addMonthsUTC(from: Date, months: number): Date {
  const day = from.getUTCDate();
  const d = new Date(from.getTime());
  // Park on the 1st first, so adding the month cannot roll over on its own
  // before the clamp below has a chance to run.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfTarget = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTarget));
  return d;
}

/**
 * Is this subscription row a real Apple purchase that has not ended?
 *
 * The guard that stops a promo redemption overwriting a paying customer.
 * `subscriptions` is one row per user, so granting a promo to somebody
 * currently paying Apple would turn their `apple_iap` row into a `promo` one
 * while Apple carried on charging them, and the next renewal webhook would land
 * against a row that no longer describes what they bought.
 *
 * Deliberately NARROWER than `resolveAccountState`, and deliberately not
 * reusing it. That answers "may this account spend money", which has a master
 * switch on top: `applySwitch` reports everybody entitled while
 * `PAYWALL_ENABLED` is unset, so asking it here would refuse every redemption
 * on production today. This asks something with no switch on it — does the row
 * describe a purchase Apple still knows about.
 *
 * `cancelled` counts as LIVE. Auto-renew is off, but they paid through the
 * period, the row still carries the `original_transaction_id`, and an
 * `UNCANCELLATION` can still arrive against it.
 *
 * `expired`, `refunded` and `revoked` do not — nothing is arriving for those,
 * and a lapsed customer is exactly who an ambassador plan is for.
 */
export function holdsLiveApplePurchase(
  row: { source: string; status: string; currentPeriodEnd: Date | null },
  now: Date
): boolean {
  if (row.source !== 'apple_iap') return false;
  if (!['active', 'grace', 'cancelled'].includes(row.status)) return false;
  // Null means no end date. It should not happen on an apple_iap row, but if it
  // does, treat it as live rather than clobber it.
  return row.currentPeriodEnd === null || row.currentPeriodEnd.getTime() > now.getTime();
}
