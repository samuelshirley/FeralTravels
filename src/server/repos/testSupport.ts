import 'server-only';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import {
  users,
  vehicles,
  trips,
  legs,
  announcements,
  announcementDismissals,
  emailOtpCodes,
  deletedUsers,
  oauthTokenUses,
  verificationTokens,
  usageEvents,
  usageAlerts,
} from '@/server/db/schema';
import { areTestEndpointsEnabled, isFixtureEmail } from '@/server/auth/test-endpoints';
/**
 * Payments is imported through its ONE public surface, never by reaching into
 * `./entitlements` or the `subscriptions` table — the whole value of that
 * module is that the number of places able to write "this user has paid"
 * stays at one, and a test helper is not an exception to that.
 */
import {
  MICROCENTS_PER_DOLLAR,
  STOP_MICROCENTS,
  WATCH_MICROCENTS,
  upsertSubscription,
} from '@/server/payments';
import type { SubscriptionSource, SubscriptionStatus } from '@/types/entitlement';
import { decryptEmail, hashEmail } from '@/server/deletedUserCrypto';
import { seededLegDateISO, seededTripStartISO } from '@/app/api/test/seedDates';
import {
  HILUX_FIXTURE_VEHICLE,
  impossibleFixtureTripReason,
} from '@/app/api/test/fixtureVehicle';
import { vehicleMeetsFuelPlanningMinimum } from '@/lib/vehicleProfile';
import { addVehicle, listVehiclesForUser } from './vehicles';
import { createTrip, addLeg } from './trips';

/**
 * TEST-ONLY fixture data layer for the E2E suite.
 *
 * The E2E specs used to reach into Postgres directly (raw SQL in
 * scripts/seed-e2e-fixture.ts + e2e/fixtures/*). That couples the tests to a
 * live DB connection and can't run against an ephemeral preview. These helpers
 * move that setup behind the app's own repo layer so it can be driven over HTTP
 * (see /api/test/*). Raw SQL stays here in the repo layer, never in the specs.
 *
 * SECURITY: every entry point asserts `areTestEndpointsEnabled()`, which is
 * ALWAYS false on real Vercel production (no override exists). These helpers
 * touch fixture DATA only — there is no session minting or auth bypass here.
 */

function assertEnabled() {
  if (!areTestEndpointsEnabled()) {
    throw new Error('test support is disabled');
  }
}

/**
 * Two legs across France/Germany — the canonical seeded itinerary.
 *
 * No `dates` here on purpose: leg dates are derived from the seed-time trip
 * start (see {@link seededLegDateISO}), never written as calendar strings.
 */
const CANONICAL_TWO_LEGS = [
  {
    sortOrder: 0,
    title: 'Paris → Strasbourg',
    label: 'Day 1',
    startName: 'Paris, France',
    endName: 'Strasbourg, France',
    startLat: 48.8566,
    startLng: 2.3522,
    endLat: 48.5734,
    endLng: 7.7521,
    distanceKm: 489,
    driveTimeMinutes: 295,
    terrain: 'Highway, mostly A-roads',
    overnight: 'Strasbourg city campsite',
    status: 'planning',
    color: '#4E7AB0',
  },
  {
    sortOrder: 1,
    title: 'Strasbourg → Stuttgart',
    label: 'Day 2',
    startName: 'Strasbourg, France',
    endName: 'Stuttgart, Germany',
    startLat: 48.5734,
    startLng: 7.7521,
    endLat: 48.7758,
    endLng: 9.1829,
    distanceKm: 156,
    driveTimeMinutes: 105,
    terrain: 'Autobahn',
    overnight: 'Stuttgart Stellplatz',
    status: 'planning',
    color: '#4A8B7A',
  },
] as const;

async function ensureUserId(email: string, name?: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalized}`)
    .limit(1);
  if (existing[0]) {
    if (name) await db.update(users).set({ name }).where(eq(users.id, existing[0].id));
    return existing[0].id;
  }
  const [row] = await db
    .insert(users)
    .values({ email: normalized, name: name ?? null, emailVerified: new Date() })
    .returning({ id: users.id });
  return row.id;
}

/**
 * Give `userId` a vehicle Finn can actually plan with, and hand back its id.
 *
 * Reuses one they already own when it passes the same bar the app enforces —
 * two vehicles on a fixture account is a state no real user reaches through
 * onboarding, and it would quietly change which one `getDefaultVehicleForUser`
 * picks. Only when the account owns nothing usable does it create the Hilux.
 *
 * `name` carries the caller's `playwright-` prefix so cleanupPlaywright sweeps
 * anything this creates; the Hilux's real NUMBERS are what the fixture is
 * borrowing, not its nickname (existing-trip.spec.ts asserts the seeded
 * vehicle's name on screen, so the name stays the caller's to choose).
 */
async function ensureFixtureVehicle(userId: string, name: string): Promise<string> {
  const owned = await listVehiclesForUser(userId);
  const usable = owned.find((v) => vehicleMeetsFuelPlanningMinimum(v as unknown as Record<string, unknown>));
  if (usable) return usable.id;
  const created = await addVehicle(userId, {
    name,
    range_km: HILUX_FIXTURE_VEHICLE.range_km,
    fuel_type: HILUX_FIXTURE_VEHICLE.fuel_type,
    is_default: true,
  });
  return created.id;
}

/**
 * Read back what we just wrote and refuse to hand over a trip the app itself
 * could never have produced.
 *
 * This is the guard, and it runs at SEED time on purpose. A fixture that seeds
 * impossible data does not fail — it produces a test account that looks broken
 * to whoever opens it, which is how a vehicle-less trip full of "Finish your
 * vehicle profile" legs reached a human before any test did. Throwing here
 * turns that into a 400 from `/api/test/seed` or `/api/test/trip`, i.e. a red
 * spec at setup, on every e2e run, without a spec having to remember to look.
 *
 * It reads the rows rather than trusting the arguments so it also catches the
 * case where the trip was fine and the VEHICLE was the thing that went missing.
 */
async function assertFixtureTripPossible(
  tripId: string,
  userId: string,
  label: string,
): Promise<void> {
  const [tripRow] = await db
    .select({ onboardingState: trips.onboardingState })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  if (!tripRow) throw new Error(`${label}: trip ${tripId} was not written`);

  const legRows = await db.select({ id: legs.id }).from(legs).where(eq(legs.tripId, tripId)).limit(1);
  const owned = await listVehiclesForUser(userId);
  const ownerBestRangeKm = owned.reduce<number | null>(
    (best, v) => (v.range_km != null && (best == null || v.range_km > best) ? v.range_km : best),
    null,
  );

  const reason = impossibleFixtureTripReason({
    onboardingState: tripRow.onboardingState,
    hasLegs: legRows.length > 0,
    ownerBestRangeKm,
  });
  if (reason) throw new Error(`${label}: ${reason}`);
}

/**
 * Reset the user's graph and recreate the canonical fixture: one default
 * vehicle + one trip (onboarding done) + two legs. Idempotent.
 */
export async function seedFixture(opts: {
  email: string;
  userName?: string;
  vehicleName: string;
  tripName: string;
}): Promise<{ userId: string; vehicleId: string; tripId: string }> {
  assertEnabled();
  const userId = await ensureUserId(opts.email, opts.userName);

  // Reset: trips (cascades legs) then vehicles, and clear units so onboarding
  // unit tests start clean.
  await db.delete(trips).where(eq(trips.userId, userId));
  await db.delete(vehicles).where(eq(vehicles.userId, userId));
  await db.update(users).set({ unitsPref: null }).where(eq(users.id, userId));

  // The Hilux's real numbers, not a made-up 400. See HILUX_FIXTURE_VEHICLE.
  const vehicle = await addVehicle(userId, {
    name: opts.vehicleName,
    range_km: HILUX_FIXTURE_VEHICLE.range_km,
    fuel_type: HILUX_FIXTURE_VEHICLE.fuel_type,
    is_default: true,
  });

  // Every seeded trip starts SEEDED_TRIP_START_OFFSET_DAYS out — see
  // seedDates.ts for why a fixture must never carry a calendar date. The old
  // version anchored day 1 to "today", which sat on the behind/ahead boundary
  // the UTC-server-vs-driver-timezone split makes ambiguous.
  const legDates = CANONICAL_TWO_LEGS.map((leg) => seededLegDateISO(leg.sortOrder));

  const trip = await createTrip({
    userId,
    name: opts.tripName,
    startDate: legDates[0],
    endDate: legDates[legDates.length - 1],
    vehicleId: vehicle.id,
  });
  await db
    .update(trips)
    .set({ onboardingState: 'done', status: 'planning' })
    .where(eq(trips.id, trip.id));

  for (const leg of CANONICAL_TWO_LEGS) {
    await addLeg({ tripId: trip.id, ...leg, dates: legDates[leg.sortOrder] ?? legDates[0] });
  }

  await assertFixtureTripPossible(trip.id, userId, 'seedFixture');
  return { userId, vehicleId: vehicle.id, tripId: trip.id };
}

/**
 * Create an ad-hoc, throwaway trip for a single spec. `name` must be supplied
 * pre-prefixed (e.g. `playwright-<runId>-...`) so {@link cleanupPlaywright}
 * sweeps it. Kinds mirror the old test-trip.ts helpers.
 */
export async function createAdHocTrip(opts: {
  email: string;
  name: string;
  kind: 'blank' | 'onboarding' | 'vehicle_new';
}): Promise<{ tripId: string; vehicleId: string | null }> {
  assertEnabled();
  const userId = await ensureUserId(opts.email);

  if (opts.kind === 'vehicle_new') {
    // Intentionally incomplete vehicle (no range) — exercises the numeric
    // validation path in the chat-composer onboarding. Legitimately violates
    // nothing: the trip is parked IN onboarding, which is the state whose
    // whole job is to collect the missing number.
    const [v] = await db
      .insert(vehicles)
      .values({ userId, name: `${opts.name} vehicle`, isDefault: false, rangeKm: null })
      .returning({ id: vehicles.id });
    const trip = await createTrip({ userId, name: opts.name, vehicleId: v.id });
    await db.update(trips).set({ onboardingState: 'vehicle_new' }).where(eq(trips.id, trip.id));
    await assertFixtureTripPossible(trip.id, userId, "createAdHocTrip('vehicle_new')");
    return { tripId: trip.id, vehicleId: v.id };
  }

  // 'blank' is a trip that has already LEFT onboarding, so it must come with a
  // vehicle — that is what leaving onboarding means. It used to take whatever
  // `getDefaultVehicleId` returned, which is null for an account that has not
  // been seeded, and produced the exact impossible pairing this file's guard
  // now names: onboarding done, no vehicle anywhere, every day of the trip
  // reporting "Finish your vehicle profile". 'onboarding' is the opposite
  // case and deliberately gets nothing.
  const vehicleId =
    opts.kind === 'blank' ? await ensureFixtureVehicle(userId, `${opts.name} vehicle`) : null;
  // 'blank' also gets the same future start every seeded trip gets.
  // 'onboarding' deliberately does NOT: its whole point is that the wizard's
  // trip_date step has not run yet, and pre-dating it would be seeding an
  // answer to the question under test.
  const trip = await createTrip({
    userId,
    name: opts.name,
    vehicleId,
    startDate: opts.kind === 'blank' ? seededTripStartISO() : null,
  });
  await db
    .update(trips)
    .set({ onboardingState: opts.kind === 'blank' ? 'done' : 'not_started' })
    .where(eq(trips.id, trip.id));
  await assertFixtureTripPossible(trip.id, userId, `createAdHocTrip('${opts.kind}')`);
  return { tripId: trip.id, vehicleId };
}

/** Delete every `playwright-`-prefixed trip and vehicle for the user. */
export async function cleanupPlaywright(
  email: string,
): Promise<{ deletedTrips: number; deletedVehicles: number }> {
  assertEnabled();
  const normalized = email.trim().toLowerCase();

  /**
   * The fixture-address check that this function's comment used to CLAIM the
   * route already made. It did not: /api/test/cleanup validates only
   * `isTestRequestAuthorized` plus `z.string().email()` — unlike
   * `readFixtureOtp` below, which has always checked. That gap mattered once
   * this function grew a `deleted_users` delete: on a preview (a copy-on-write
   * clone of PROD data) a caller holding the per-run secret could erase the
   * tombstones of a real person who had asked to be forgotten. Production is
   * not exposed — test endpoints are hard-off there — but "not exposed in prod"
   * is not the same as "safe", and a comment asserting a guard that does not
   * exist is worse than no comment.
   */
  if (!isFixtureEmail(normalized)) {
    throw new Error('cleanupPlaywright: not a fixture address');
  }

  // BEFORE the user lookup, deliberately. The account-deletion spec leaves a
  // tombstone behind and no user row — which is the feature working — so a
  // cleanup that bails on "user not found" would never reach this and every
  // local run would add permanent `playwright-*` noise to /admin/deleted. The
  // digest is deterministic, so this matches exactly the rows this address
  // produced.
  await db.delete(deletedUsers).where(eq(deletedUsers.emailHash, hashEmail(normalized)));

  const found = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalized}`)
    .limit(1);
  if (!found[0]) return { deletedTrips: 0, deletedVehicles: 0 };
  const userId = found[0].id;

  const dt = await db
    .delete(trips)
    .where(and(eq(trips.userId, userId), like(trips.name, 'playwright-%')))
    .returning({ id: trips.id });
  const dv = await db
    .delete(vehicles)
    .where(and(eq(vehicles.userId, userId), like(vehicles.name, 'playwright-%')))
    .returning({ id: vehicles.id });

  return { deletedTrips: dt.length, deletedVehicles: dv.length };
}

/**
 * Seed a fresh active announcement for the announcement E2E, "parking" any
 * other currently-active announcements (deactivating them) so the app's
 * newest-active-undismissed query returns exactly the seeded one. Returns the
 * seeded id and the parked ids so cleanup can restore them.
 */
export async function seedAnnouncement(opts: {
  title: string;
  body: string;
  buttonText: string;
}): Promise<{ announcementId: string; parkedIds: string[] }> {
  assertEnabled();
  // Remove any leftover announcement with the same title (prior failed run).
  await db.delete(announcements).where(eq(announcements.title, opts.title));

  const active = await db
    .select({ id: announcements.id })
    .from(announcements)
    .where(eq(announcements.active, true));
  const parkedIds = active.map((r) => r.id);
  if (parkedIds.length > 0) {
    await db
      .update(announcements)
      .set({ active: false })
      .where(inArray(announcements.id, parkedIds));
  }

  const [row] = await db
    .insert(announcements)
    .values({
      title: opts.title,
      body: opts.body,
      buttonText: opts.buttonText,
      active: true,
    })
    .returning({ id: announcements.id });

  return { announcementId: row.id, parkedIds };
}

/** Undo {@link seedAnnouncement}: drop the seeded announcement + its dismissals, restore parked. */
export async function cleanupAnnouncement(opts: {
  announcementId: string;
  parkedIds?: string[];
}): Promise<void> {
  assertEnabled();
  await db
    .delete(announcementDismissals)
    .where(eq(announcementDismissals.announcementId, opts.announcementId));
  await db.delete(announcements).where(eq(announcements.id, opts.announcementId));
  if (opts.parkedIds && opts.parkedIds.length > 0) {
    await db
      .update(announcements)
      .set({ active: true })
      .where(inArray(announcements.id, opts.parkedIds));
  }
}

/**
 * TEST-ONLY: the pending OTP code for a fixture address.
 *
 * Refuses anything outside the fixture pattern, so this cannot be pointed at a
 * real account even by a caller holding the per-run secret. Returns null when
 * no unexpired code exists — the spec polls, because the code is written by
 * the /login request it just made.
 */
export async function readFixtureOtp(email: string): Promise<string | null> {
  assertEnabled();
  const normalized = email.trim().toLowerCase();
  if (!isFixtureEmail(normalized)) {
    throw new Error('readFixtureOtp: not a fixture address');
  }
  const rows = await db
    .select({ code: emailOtpCodes.code, expires: emailOtpCodes.expires })
    .from(emailOtpCodes)
    .where(eq(emailOtpCodes.email, normalized))
    .limit(1);
  if (rows.length === 0) return null;
  if (rows[0].expires.getTime() < Date.now()) return null;
  return rows[0].code;
}

/**
 * TEST-ONLY: plant a `usage_events` row for a fixture user.
 *
 * Account deletion does not delete usage rows — it ANONYMISES them: the FK
 * actions null out `user_id` and `trip_id`, and the repo explicitly clears
 * `error_message`, which is where the user's own words end up (`penny:user-idea`
 * holds the sentence they typed; `penny:contiguity-gap` holds place names from
 * their itinerary). That is the actual privacy promise the policy page makes,
 * and nothing asserted it.
 *
 * `provider` is the marker column: it is NOT NULL and deletion never touches
 * it, so a per-run value survives and lets the spec find its own rows again
 * afterwards without racing the three other workers.
 */
export async function seedUsageEvent(opts: {
  email: string;
  provider: string;
  errorMessage: string;
}): Promise<{ id: number; userId: string }> {
  assertEnabled();
  const normalized = opts.email.trim().toLowerCase();
  if (!isFixtureEmail(normalized)) {
    throw new Error('seedUsageEvent: not a fixture address');
  }

  const found = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalized}`)
    .limit(1);
  if (!found[0]) throw new Error('seedUsageEvent: no such user');

  const [row] = await db
    .insert(usageEvents)
    .values({
      userId: found[0].id,
      provider: opts.provider,
      success: false,
      errorMessage: opts.errorMessage,
    })
    .returning({ id: usageEvents.id });

  return { id: row.id, userId: found[0].id };
}

/** What {@link readDeletionState} reports. Counts only — never an address. */
export interface DeletionState {
  /** Rows in `users` for this address: 1 before, 0 after. */
  userRows: number;
  /** The user's id while they still exist, so the caller can ask about it later. */
  userId: string | null;
  /** Rows still bearing `userId` — trips cascade, usage rows are set NULL. */
  tripsForUser: number;
  usageForUser: number;
  /** Marker rows anywhere, and how many still carry free text. */
  usageWithMarker: number;
  usageWithMarkerText: number;
  /** The three email-keyed tables a cascade cannot see. */
  otpCodes: number;
  oauthTokenUses: number;
  verificationTokens: number;
  tombstones: Array<{
    signInProviders: string | null;
    accountCreatedAt: string | null;
    tripCount: number;
    vehicleCount: number;
    chatMessageCount: number;
    deletedBy: string;
    /** Whether a ciphertext was written at all (false when no key is configured). */
    hasCiphertext: boolean;
    /** Whether that ciphertext decrypts back to the address that was asked about. */
    ciphertextMatchesEmail: boolean;
  }>;
}

/**
 * TEST-ONLY: what the database still holds about a fixture address.
 *
 * Exists because the deletion spec had no vantage point after the fact. Its
 * strongest assertion was `GET /api/trips` → 401, which only proves the
 * SESSION died: an implementation that deleted `sessions` and nothing else
 * passed every test in the file. Everything below is a count or a boolean —
 * the decrypted address is compared here and never crosses the wire, so this
 * reads data without becoming a way to read data out.
 */
export async function readDeletionState(opts: {
  email: string;
  userId?: string | null;
  marker?: string | null;
}): Promise<DeletionState> {
  assertEnabled();
  const normalized = opts.email.trim().toLowerCase();
  if (!isFixtureEmail(normalized)) {
    throw new Error('readDeletionState: not a fixture address');
  }

  const userRows = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalized}`);

  const userId = opts.userId ?? userRows[0]?.id ?? null;

  const tripRows = userId
    ? await db.select({ id: trips.id }).from(trips).where(eq(trips.userId, userId))
    : [];
  const usageRows = userId
    ? await db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.userId, userId))
    : [];

  const markerRows = opts.marker
    ? await db
        .select({ id: usageEvents.id, errorMessage: usageEvents.errorMessage })
        .from(usageEvents)
        .where(eq(usageEvents.provider, opts.marker))
    : [];

  const otpRows = await db
    .select({ email: emailOtpCodes.email })
    .from(emailOtpCodes)
    .where(sql`lower(${emailOtpCodes.email}) = ${normalized}`);
  const oauthRows = await db
    .select({ tokenHash: oauthTokenUses.tokenHash })
    .from(oauthTokenUses)
    .where(sql`lower(${oauthTokenUses.email}) = ${normalized}`);
  const verificationRows = await db
    .select({ identifier: verificationTokens.identifier })
    .from(verificationTokens)
    .where(sql`lower(${verificationTokens.identifier}) = ${normalized}`);

  const tombstoneRows = await db
    .select()
    .from(deletedUsers)
    .where(eq(deletedUsers.emailHash, hashEmail(normalized)));

  return {
    userRows: userRows.length,
    userId,
    tripsForUser: tripRows.length,
    usageForUser: usageRows.length,
    usageWithMarker: markerRows.length,
    usageWithMarkerText: markerRows.filter((r) => r.errorMessage !== null).length,
    otpCodes: otpRows.length,
    oauthTokenUses: oauthRows.length,
    verificationTokens: verificationRows.length,
    tombstones: tombstoneRows.map((row) => ({
      signInProviders: row.signInProviders,
      accountCreatedAt: row.accountCreatedAt ? row.accountCreatedAt.toISOString() : null,
      tripCount: row.tripCount,
      vehicleCount: row.vehicleCount,
      chatMessageCount: row.chatMessageCount,
      deletedBy: row.deletedBy,
      hasCiphertext: row.emailEncrypted !== null,
      ciphertextMatchesEmail: decryptEmail(row.emailEncrypted) === normalized,
    })),
  };
}

/**
 * TEST-ONLY: drop the marker rows {@link seedUsageEvent} planted.
 *
 * After the account goes, those rows are anonymous by design — no `user_id`,
 * no address — so `cleanupPlaywright` has nothing to find them by and the
 * suite would leave one orphan per run behind forever.
 *
 * The `e2e-` prefix is a hard requirement, not a convention: without it this
 * would be "delete every usage row for the provider you name", and
 * `{ marker: 'anthropic' }` would erase the real billing history on any
 * environment where test endpoints are on — which includes previews, and a
 * preview is a copy-on-write clone of production data.
 */
export async function deleteUsageByMarker(marker: string): Promise<{ deleted: number }> {
  assertEnabled();
  if (!/^e2e-/.test(marker)) {
    throw new Error('deleteUsageByMarker: marker must start with "e2e-"');
  }
  const rows = await db
    .delete(usageEvents)
    .where(eq(usageEvents.provider, marker))
    .returning({ id: usageEvents.id });
  return { deleted: rows.length };
}

// ── Subscription fixture state ──────────────────────────────────────────────

/**
 * The `provider` on every synthetic spend row {@link setSubscriptionFixtureState}
 * writes.
 *
 * Two constraints meet here and only one string satisfies both. It must start
 * with `anthropic` or `anthropicMicrocentsInWindow` (`provider LIKE
 * 'anthropic%'`) will not count it and the cap specs would assert against a
 * total of zero — the green-but-empty failure mode. And it must be
 * unmistakably synthetic to anyone reading `/admin/errors` or the spend
 * numbers, because on a preview those rows sit in a copy-on-write clone of
 * production data.
 */
const SUBSCRIPTION_FIXTURE_PROVIDER = 'anthropic:e2e-subscription-fixture';

export interface SubscriptionFixtureInput {
  email: string;
  /**
   * REQUIRED, and deliberately not defaulted.
   *
   * `isCompedEmail` matches the fixture pattern, so every
   * `playwright-*@e2e.feraltravels.com` address is comped BY DESIGN — and a
   * comped account can never be paywalled, which would turn every paywall
   * assertion in the suite into an assertion about nothing. A default here is
   * exactly how that silence would get introduced, so each caller has to say
   * which side of the line its fixture user is on.
   *
   * (Today the web OTP path does not call `syncCompedFlagOnSignIn` at all —
   * only the Auth.js events do — so a fixture user signed in by code lands
   * with `comped = false` from the column default. That is an accident, not a
   * guarantee, and the specs must not lean on it either way.)
   */
  comped: boolean;
  /** Age the account. Resolved against the SERVER's clock, not the runner's. */
  createdAtDaysAgo?: number | null;
  /** Replaces the synthetic spend total for this user. 0 clears it. */
  anthropicSpendUsd?: number | null;
  /**
   * Plant the `usage_alerts` claim rows for any threshold the synthetic spend
   * crosses, so `maybeAlertThreshold` finds the row already taken and skips
   * the send.
   *
   * Default true, because the alternative is that every CI run mails
   * support@feraltravels.com two or three times about fake spend on an
   * address that cannot receive mail. This is not a new suppression mechanism:
   * it is the SAME row, with the same primary key, that stops a capped user
   * mailing support a hundred times in an afternoon.
   *
   * The cost is that no spec can assert the alert fires. Nothing here could
   * have: the send is fire-and-forget through Resend with no vantage point on
   * this side. It is covered by the payments unit tests, not by Playwright.
   */
  suppressThresholdAlerts?: boolean;
  /**
   * Written through `upsertSubscription` — the module's single writer of that
   * table — so a fixture row cannot be shaped in a way a real one could not.
   *
   * There is deliberately no way to REMOVE a row: a spec that needs an account
   * with no subscription uses a fresh user, which has none.
   */
  subscription?: {
    status: SubscriptionStatus;
    source?: SubscriptionSource;
    productId?: string | null;
    autoRenew?: boolean;
    /** Negative for a period that has already ended. Null means "no end date". */
    currentPeriodEndDaysFromNow?: number | null;
  } | null;
}

export interface SubscriptionFixtureState {
  userId: string;
  createdAt: string;
  comped: boolean;
  anthropicMicrocents: number;
  subscriptionStatus: SubscriptionStatus | null;
  currentPeriodEnd: string | null;
}

/**
 * TEST-ONLY: put a fixture account into one of the eleven account states.
 *
 * Sets STATE, never entitlement: it writes the same four things a real account
 * accumulates — its age, its comp flag, its Anthropic spend and its
 * subscription row — and then lets `getAccountVerdict` reach whatever verdict
 * those facts imply. Nothing here decides that a user is entitled, which is
 * what makes the specs built on it worth running: they exercise the real
 * resolver against real rows.
 *
 * The user must already exist. This does not create accounts, and it mints no
 * session — sign-in stays the real OTP flow.
 */
export async function setSubscriptionFixtureState(
  opts: SubscriptionFixtureInput,
): Promise<SubscriptionFixtureState> {
  assertEnabled();
  const normalized = opts.email.trim().toLowerCase();
  // Belt and braces: the route refuses a non-fixture address too. This is the
  // check that survives someone adding a second caller.
  if (!isFixtureEmail(normalized)) {
    throw new Error('setSubscriptionFixtureState: not a fixture address');
  }

  const found = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalized}`)
    .limit(1);
  if (!found[0]) throw new Error('setSubscriptionFixtureState: no such user');
  const userId = found[0].id;

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  const patch: { comped: boolean; createdAt?: Date } = { comped: opts.comped };
  if (opts.createdAtDaysAgo != null) {
    patch.createdAt = new Date(now.getTime() - opts.createdAtDaysAgo * dayMs);
  }
  await db.update(users).set(patch).where(eq(users.id, userId));

  // Spend: one row, replaced wholesale, so calling this twice on one user is
  // idempotent rather than cumulative.
  await db
    .delete(usageEvents)
    .where(
      and(eq(usageEvents.userId, userId), eq(usageEvents.provider, SUBSCRIPTION_FIXTURE_PROVIDER)),
    );
  const microcents =
    opts.anthropicSpendUsd != null ? Math.round(opts.anthropicSpendUsd * MICROCENTS_PER_DOLLAR) : 0;
  if (microcents > 0) {
    await db.insert(usageEvents).values({
      userId,
      provider: SUBSCRIPTION_FIXTURE_PROVIDER,
      requests: 1,
      costMicrocents: microcents,
      success: true,
    });
  }

  // Alert claims. Cleared first so lowering the spend on a reused user does
  // not leave a stale claim behind.
  await db.delete(usageAlerts).where(eq(usageAlerts.userId, userId));
  if (opts.suppressThresholdAlerts !== false) {
    const crossed: Array<'watch' | 'stop'> = [];
    if (microcents >= WATCH_MICROCENTS) crossed.push('watch');
    if (microcents >= STOP_MICROCENTS) crossed.push('stop');
    for (const threshold of crossed) {
      await db
        .insert(usageAlerts)
        .values({ userId, threshold, microcentsAtFiring: microcents })
        .onConflictDoNothing();
    }
  }

  let currentPeriodEnd: Date | null = null;
  if (opts.subscription) {
    const sub = opts.subscription;
    currentPeriodEnd =
      sub.currentPeriodEndDaysFromNow == null
        ? null
        : new Date(now.getTime() + sub.currentPeriodEndDaysFromNow * dayMs);
    await upsertSubscription({
      userId,
      status: sub.status,
      // `fake` is the source that "never exists in production data" — the
      // correct label for a subscription nobody paid for.
      source: sub.source ?? 'fake',
      productId: sub.productId ?? null,
      currentPeriodEnd,
      autoRenew: sub.autoRenew ?? true,
    });
  }

  const [userRow] = await db
    .select({ createdAt: users.createdAt, comped: users.comped })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return {
    userId,
    createdAt: userRow.createdAt.toISOString(),
    comped: userRow.comped,
    anthropicMicrocents: microcents,
    subscriptionStatus: opts.subscription?.status ?? null,
    currentPeriodEnd: currentPeriodEnd?.toISOString() ?? null,
  };
}
