import 'server-only';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { promoCodes, subscriptionEvents, users } from '@/server/db/schema';
import {
  decidePromoRedemption,
  generatePromoCode,
  isPromoCodeShape,
  normalizePromoCode,
  type PromoRefusal,
} from '@/lib/promoCode';
import { upsertSubscription } from './entitlements';

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
 * Unlimited duration (`currentPeriodEnd: null`, which the admin UI already
 * renders as unlimited) and the ORDINARY usage cap. The owner's call, and the
 * reasoning is sound: a promo recipient is being asked to use the app hard and
 * should not have to think about a renewal date, but the $8.50 rolling-twelve-
 * month Anthropic ceiling still applies because a promo account generates no
 * revenue to offset it. If they hit it, that is a signal about per-trip cost —
 * which is what the cap is for.
 */

/** The single-use grant a redeemed code writes. */
const PROMO_GRANT = {
  status: 'active',
  source: 'promo',
  /**
   * No store product — nobody bought anything. The admin panel reads this
   * column to tell a promo apart from a purchase at a glance.
   */
  productId: null,
  /** Null = no end date. Unlimited, as the owner specified. */
  currentPeriodEnd: null,
  /**
   * True, and it is the lesser of two inaccuracies. Nothing renews a promo —
   * but `autoRenew: false` resolves to `cancelled_in_period`, which would tell
   * the admin panel a story about a cancellation that never happened. `true`
   * resolves to plain `subscribed`, and `source` carries the real story.
   */
  autoRenew: true,
} as const;

export interface CreatePromoCodeInput {
  /** Who it is for. Redemption refuses any other address. */
  email: string;
  /** The admin's own note — who this is, why. Optional. */
  note?: string | null;
  /** Admin address minting it. Recorded, never null. */
  createdBy: string;
  /** Deadline to REDEEM. Null = never goes stale. */
  expiresAt?: Date | null;
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

  await upsertSubscription({ userId: params.userId, ...PROMO_GRANT });

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
