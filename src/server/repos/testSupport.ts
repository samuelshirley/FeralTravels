import 'server-only';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import {
  users,
  vehicles,
  trips,
  announcements,
  announcementDismissals,
  emailOtpCodes,
  deletedUsers,
  oauthTokenUses,
  verificationTokens,
  usageEvents,
} from '@/server/db/schema';
import { areTestEndpointsEnabled, isFixtureEmail } from '@/server/auth/test-endpoints';
import { decryptEmail, hashEmail } from '@/server/deletedUserCrypto';
import { addVehicle, getDefaultVehicleId } from './vehicles';
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

/** Two legs across France/Germany — the canonical seeded itinerary. */
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
    dates: '2026-06-01',
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
    dates: '2026-06-02',
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

  const vehicle = await addVehicle(userId, {
    name: opts.vehicleName,
    comfortable_range_km: 400,
    hard_max_range_km: 400,
    is_default: true,
  });

  // Anchor the fixture to "now" so the itinerary doesn't collapse the legs as
  // "behind you" (past days) — that hides leg cards, points nav links at the
  // wrong leg, and suppresses lazy fuel sourcing, all of which the
  // existing-trip / lazy-fuel specs assert on. Hardcoded past dates broke them.
  const isoPlus = (days: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const legDates = [isoPlus(0), isoPlus(1)];

  const trip = await createTrip({
    userId,
    name: opts.tripName,
    startDate: legDates[0],
    endDate: legDates[1],
    vehicleId: vehicle.id,
  });
  await db
    .update(trips)
    .set({ onboardingState: 'done', status: 'planning' })
    .where(eq(trips.id, trip.id));

  for (const leg of CANONICAL_TWO_LEGS) {
    await addLeg({ tripId: trip.id, ...leg, dates: legDates[leg.sortOrder] ?? legDates[0] });
  }

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
    // validation path in the chat-composer onboarding.
    const [v] = await db
      .insert(vehicles)
      .values({ userId, name: `${opts.name} vehicle`, isDefault: false, comfortableRangeKm: null })
      .returning({ id: vehicles.id });
    const trip = await createTrip({ userId, name: opts.name, vehicleId: v.id });
    await db.update(trips).set({ onboardingState: 'vehicle_new' }).where(eq(trips.id, trip.id));
    return { tripId: trip.id, vehicleId: v.id };
  }

  const vehicleId = opts.kind === 'blank' ? await getDefaultVehicleId(userId) : null;
  const trip = await createTrip({ userId, name: opts.name, vehicleId });
  await db
    .update(trips)
    .set({ onboardingState: opts.kind === 'blank' ? 'done' : 'not_started' })
    .where(eq(trips.id, trip.id));
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
