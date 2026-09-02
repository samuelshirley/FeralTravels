import 'server-only';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { promoCodes, subscriptionEvents, users } from '@/server/db/schema';
import {
  addMonthsUTC,
  decidePromoRedemption,
  isPromoGrantMonths,
  PROMO_GRANT_MONTHS,
  type PromoGrantMonths,
  generatePromoCode,
  isPromoCodeShape,
  normalizePromoCode,
  type PromoRefusal,
} from '@/lib/promoCode';
import { getSubscriptionRow, upsertSubscription } from './entitlements';

/**
 * Re-exported so `@/server/payments` stays the one import site for this
 * feature. They LIVE in `src/lib/promoCode.ts` because this file is
 * `server-only` and the unit project cannot import it — the same split that
 * already puts `decidePromoRedemption` there.
 */
export { addMonthsUTC, isPromoGrantMonths, PROMO_GRANT_MONTHS };
export type { PromoGrantMonths };
import { logUsageEvent } from '@/server/repos/usage';

/**
 * Promo codes: an admin hands one to a person, that person redeems it, and the
 * paywall lets them through.
 *
 * ── The design decision worth reading before changing anything here ──
 *
 * Redeeming writes an ordinary `subscriptions` row with `source: 'promo'`. It
 * does NOT add a branch to `resolveAccountState`, and nothing in the paywall
 * path reads `promo_codes` at all.
 *
 * That is deliberate. The value of `src/server/payments/` is that the number of
 * places able to decide "this account has paid" stays at ONE. A second
 * entitlement source would have been a second such place — and the account
 * state machine, its twelve tested states, the admin panel and the mobile app
 * would all have needed to learn about it. Instead a promo user is exactly what
 * they look like: a subscriber, whose row records where the subscription came
 * from. `hasEntitlement` needed no change whatsoever.
 *
 * ── What it grants ──
 *
 * A FIXED TERM — six or twelve months from REDEMPTION — and the ORDINARY usage
 * cap. It used to be unlimited; the term is the owner's call.
 *
 * The clock starts at redemption, not at minting. Minting is when an admin
 * types an address into a form; redemption is when the recipient actually has
 * the app. A six-month code minted today and redeemed in three weeks would
 * otherwise be five months and a week of a gift meant as six, with nothing
 * telling anybody. `expiresAt` is the separate control for "use it or lose it",
 * and it is the right one for that job.
 *
 * `resolveAccountState` needed NO change for the term to work. Its `periodOver`
 * branch already treats an `active` row with a past `current_period_end` as
 * `expired` — "the clock is the authority, not the stale status" — which was
 * written for a missing renewal webhook and turns out to be exactly right for a
 * promo that has run out. `promo.test.ts` pins that for a promo row
 * specifically, because it is now load-bearing for a second reason.
 *
 * The $8.50 rolling-twelve-month Anthropic ceiling still applies: a promo
 * account generates no revenue to offset it, and hitting it is a signal about
 * per-trip cost, which is what the cap is for.
 */

/** The single-use grant a redeemed code writes. */
function promoGrant(grantMonths: number, now: Date) {
  return {
    status: 'active',
    source: 'promo',
    /**
     * No store product — nobody bought anything. The admin panel reads this
     * column to tell a promo apart from a purchase at a glance, and
     * `planStatusLine` reads `source` to call it an Ambassador plan rather
     * than guessing a product name it does not have.
     */
    productId: null,
    /**
     * The term, from NOW — the moment of redemption. See the header.
     *
     * This used to be null, meaning no end. Everything downstream already
     * handled a real date, because a paid subscription has one.
     */
    currentPeriodEnd: addMonthsUTC(now, grantMonths),
    /**
     * True, and it is the lesser of two inaccuracies. Nothing renews a promo —
     * but `autoRenew: false` resolves to `cancelled_in_period`, which would tell
     * the admin panel a story about a cancellation that never happened. `true`
     * resolves to plain `subscribed`, and `source` carries the real story.
     *
     * Still true with a term: the row expires on its date via `periodOver`
     * whatever `autoRenew` says, so this changes nothing about when access ends.
     */
    autoRenew: true,
  } as const;
}

export interface CreatePromoCodeInput {
  /** Who it is for. Redemption refuses any other address. */
  email: string;
  /** The admin's own note — who this is, why. Optional. */
  note?: string | null;
  /** Admin address minting it. Recorded, never null. */
  createdBy: string;
  /** Deadline to REDEEM. Null = never goes stale. NOT the length of access. */
  expiresAt?: Date | null;
  /** How long the access lasts once redeemed. 6 or 12. No default: the admin picks. */
  grantMonths: PromoGrantMonths;
}

export interface PromoCodeRow {
  id: string;
  code: string;
  email: string;
  note: string | null;
  createdBy: string;
  expiresAt: Date | null;
  redeemedAt: Date | null;
  redeemedByUserId: string | null;
  createdAt: Date;
  grantMonths: number;
}

/**
 * Mint a code for one address.
 *
 * Collisions are handled by the unique index rather than by asking the database
 * whether a code exists first. A check-then-insert is a TOCTOU, and the repo has
 * already been bitten by one of those (`penny_turns_one_running_per_trip_idx`
 * exists because of it) — so the insert IS the check, and a `23505` means
 * "unlucky, draw again".
 *
 * Five attempts is not a tuning parameter. With 27^8 codes a collision needs
 * roughly a billion existing rows to be likely once; five consecutive failures
 * means something is wrong with the random source, and throwing is the correct
 * response to that.
 */
export async function createPromoCode(
  input: CreatePromoCodeInput,
  randomBytes: (n: number) => Uint8Array = (n) => new Uint8Array(nodeRandomBytes(n))
): Promise<PromoCodeRow> {
  const email = input.email.trim().toLowerCase();
  const note = input.note?.trim() || null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generatePromoCode(randomBytes);
    try {
      const [row] = await db
        .insert(promoCodes)
        .values({
          code,
          email,
          note,
          createdBy: input.createdBy.trim().toLowerCase(),
          expiresAt: input.expiresAt ?? null,
          grantMonths: input.grantMonths,
        })
        .returning();
      return row as PromoCodeRow;
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new Error('promo: could not mint a unique code in five attempts');
}

export type RedeemResult = { ok: true; code: string } | { ok: false; reason: PromoRefusal };

/**
 * Redeem a code for a signed-in user.
 *
 * Two steps, and the split is the point:
 *
 *   1. `decidePromoRedemption` (pure, unit-tested) answers whether this user
 *      MAY have it — bound to them, not spent, not expired.
 *   2. A conditional UPDATE claims it: `WHERE id = ? AND redeemed_at IS NULL`,
 *      returning the row. Postgres decides the winner, so two requests landing
 *      together cannot both come back with a grant. A pure function cannot make
 *      a promise about concurrency, so it does not try to.
 *
 * The claim happens BEFORE the subscription is written. If the grant then fails,
 * the code is spent and the account is not — an admin can see that in
 * `/admin/promo` and mint another. The other order loses far worse: an
 * unclaimed code that has already granted access is one somebody can spend
 * twice.
 */
export async function redeemPromoCode(params: {
  userId: string;
  email: string;
  rawCode: string;
  now?: Date;
}): Promise<RedeemResult> {
  const now = params.now ?? new Date();
  const code = normalizePromoCode(params.rawCode);

  // A malformed string cannot match any row, so this is only about the ERROR the
  // user reads. Telling someone the code contains a character codes never
  // contain beats a lookup miss reading as "invalid code" when they simply typed
  // an O for a 0.
  if (!isPromoCodeShape(code)) return { ok: false, reason: 'promo_not_found' };

  const [row] = await db.select().from(promoCodes).where(eq(promoCodes.code, code)).limit(1);

  const decision = decidePromoRedemption(
    row
      ? { code: row.code, email: row.email, expiresAt: row.expiresAt, redeemedAt: row.redeemedAt }
      : null,
    { email: params.email, now }
  );
  if (!decision.ok) return decision;

  const claimed = await db
    .update(promoCodes)
    .set({ redeemedAt: now, redeemedByUserId: params.userId })
    .where(and(eq(promoCodes.id, row.id), isNull(promoCodes.redeemedAt)))
    .returning({ id: promoCodes.id });

  // Lost the race. Someone — realistically this same user double-tapping —
  // claimed it between the read and the update.
  if (claimed.length === 0) return { ok: false, reason: 'promo_already_redeemed' };

  await upsertSubscription({ userId: params.userId, ...promoGrant(row.grantMonths, now) });

  // Through the same ledger a real webhook uses, so the admin event log tells
  // the true story of how this account became entitled. `source: 'promo'` on the
  // subscription says what it is; this says exactly when and which code.
  await db
    .insert(subscriptionEvents)
    .values({
      eventId: `promo:${row.id}`,
      userId: params.userId,
      type: 'PROMO_REDEEMED',
      eventTimeMs: now.getTime(),
      payload: { code, grantedTo: params.email, promoCodeId: row.id },
      outcome: 'applied',
    })
    // Keyed on the code's own id, so a replay cannot write a second event even
    // if the claim above were ever made re-runnable.
    .onConflictDoNothing();

  return { ok: true, code };
}

/** Newest first, for the admin list. Joined to the redeemer's address so the page can say who spent it. */
export async function listPromoCodes(limit = 50) {
  return db
    .select({
      id: promoCodes.id,
      code: promoCodes.code,
      email: promoCodes.email,
      note: promoCodes.note,
      createdBy: promoCodes.createdBy,
      expiresAt: promoCodes.expiresAt,
      redeemedAt: promoCodes.redeemedAt,
      createdAt: promoCodes.createdAt,
      grantMonths: promoCodes.grantMonths,
      redeemedByEmail: users.email,
    })
    .from(promoCodes)
    .leftJoin(users, eq(users.id, promoCodes.redeemedByUserId))
    .orderBy(desc(promoCodes.createdAt))
    .limit(limit);
}

/** Count of unspent codes, for the admin card. */
export async function countOutstandingPromoCodes(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(promoCodes)
    .where(isNull(promoCodes.redeemedAt));
  return row?.n ?? 0;
}

/** Postgres unique-violation SQLSTATE. Same check as `repos/pennyTurns.ts`. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/**
 * Redeem a code for someone the moment they sign in, without them typing it.
 *
 * The flow this serves: an admin mints a code for alice@example.com and tells
 * her to sign up. She does, and she is simply on the plan. Before this, minting
 * granted nothing and she had to find a purchase sheet and paste a string —
 * which is a step you have to explain in the same email, and a step that fails
 * silently if she mistypes it.
 *
 * WIRED INTO BOTH SIGN-IN PATHS, and that is not belt-and-braces. Auth.js's
 * `signIn`/`createUser` events do NOT fire for `createSessionForEmail`, which
 * is what the OTP flow and `/api/mobile/oauth/exchange` actually use — so
 * wiring only the events would have covered web OAuth and missed every emailed
 * code and every native sign-in. That exact mistake has already been made once
 * in this repo with `syncCompedFlagOnSignIn`; the comment beside its second
 * call site says so.
 *
 * ── What it deliberately does NOT do ──
 *
 * It adds no second grant path. It calls `redeemPromoCode`, so the atomic claim
 * (`UPDATE ... WHERE redeemed_at IS NULL RETURNING`) is the same one the manual
 * box uses and two concurrent sign-ins cannot both win a code. Nothing here
 * writes a subscription itself, and nothing in the paywall path learns about
 * `promo_codes`.
 *
 * It never blocks a sign-in. Every failure is caught, logged and swallowed: a
 * promo that cannot be claimed must not be the reason somebody cannot get into
 * the app. The manual redeem box stays in both purchase sheets as the fallback
 * — and it is a real fallback, for the common case of somebody signing up with
 * a different address than the one the code was minted for.
 */
export async function claimPromoOnSignIn(params: {
  userId: string;
  email: string;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const email = params.email.trim().toLowerCase();
  if (!email) return;

  const [row] = await db
    .select({ code: promoCodes.code })
    .from(promoCodes)
    .where(and(eq(promoCodes.email, email), isNull(promoCodes.redeemedAt)))
    // Oldest first: if somebody has two codes, the one issued first is the one
    // they were promised first, and the other stays claimable.
    .orderBy(promoCodes.createdAt)
    .limit(1);

  // The overwhelmingly common case. No lookup failure, nothing to do.
  if (!row) return;

  /**
   * NEVER CLOBBER A REAL PURCHASE.
   *
   * `upsertSubscription` writes ONE row per user, so granting a promo to
   * somebody who already pays Apple would overwrite their `apple_iap` row with
   * a `promo` one — while Apple carries on charging them, and while the webhook
   * for their next renewal arrives against a row that no longer describes what
   * they bought. The manual box has always had this hazard, but a user typing a
   * code is at least choosing; doing it silently on sign-in is not.
   *
   * The narrow rule is the right one: leave a paid row alone, overwrite
   * anything else (no row, an admin grant, a spent promo, a test purchase).
   * The code stays unredeemed and the manual box still works if their
   * subscription later lapses.
   *
   * Deliberately NOT `hasEntitlement`: that answer runs through `applySwitch`,
   * which reports everybody as entitled while `PAYWALL_ENABLED` is unset — so
   * on production today it would skip every single claim.
   */
  const existing = await getSubscriptionRow(params.userId);
  if (existing?.source === 'apple_iap') return;

  const result = await redeemPromoCode({
    userId: params.userId,
    email,
    rawCode: row.code,
    now,
  });

  if (!result.ok) {
    /**
     * Logged rather than thrown. `promo_expired` is ordinary and expected —
     * somebody signing up after the deadline — and `promo_already_redeemed`
     * means a concurrent claim won, which is the atomic claim doing its job.
     * Neither is a reason to fail a sign-in, and both are worth being able to
     * read afterwards in /admin/errors.
     */
    await logUsageEvent({
      userId: params.userId,
      provider: 'promo:auto-claim',
      requests: 0,
      success: false,
      errorMessage: `${result.reason} for ${email}`,
    }).catch(() => {});
  }
}
