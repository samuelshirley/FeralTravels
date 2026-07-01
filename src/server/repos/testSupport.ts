import 'server-only';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { users, vehicles, trips, announcements, announcementDismissals } from '@/server/db/schema';
import { isAuthTestBackdoorConfigured } from '@/server/auth/test-backdoor';
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
 * SECURITY: every entry point asserts `isAuthTestBackdoorConfigured()`, which is
 * false on real Vercel production unless explicitly opted in. Inert in prod.
 */

function assertEnabled() {
  if (!isAuthTestBackdoorConfigured()) {
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
