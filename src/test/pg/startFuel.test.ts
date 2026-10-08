import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());
// Finn's station search is a PAID Google call. Every station here is a fixture
// returned by this mock; nothing leaves the process.
vi.mock('@/server/google/accounted', () => ({
  searchFuelAlongRouteAccounted: vi.fn(),
  getDirectionsAccounted: vi.fn(),
}));
// Onboarding's three model calls (intent scan, date parser, range estimator).
// None runs on the steps under test; mocked so no import reaches for a key.
vi.mock('@/server/onboardingIntentScan', () => ({ scanFirstMessage: vi.fn() }));
vi.mock('@/server/parseStartDate', () => ({ resolveStartDate: vi.fn() }));
vi.mock('@/server/parseRangeEstimate', () => ({ estimateRange: vi.fn() }));

import { and, asc, eq } from 'drizzle-orm';
import { chatHistory, stops, trips } from '@/server/db/schema';
import { addLeg, createTrip, getTripFull } from '@/server/repos/trips';
import { addVehicle } from '@/server/repos/vehicles';
import { setUnitsPref } from '@/server/repos/users';
import { getOnboardingSnapshot, submitAnswer, START_FUEL_QUESTION } from '@/server/onboarding';
import { planFuelStopsForLeg } from '@/server/fuel';
import { searchFuelAlongRouteAccounted } from '@/server/google/accounted';
import type { FuelStation } from '@/lib/google/places';
import type { StartFuel } from '@/types/trip';
import { resetDb, seedUser, testDb } from './harness';

/**
 * The starting tank, end to end through the real modules against a real
 * Postgres: the onboarding step stores a closed answer and hands off, and
 * Finn turns `fill_at_start` into a fill-up at the first station of the first
 * drive day — with the rest of the trip planned from a full tank THERE.
 */

beforeEach(async () => {
  await resetDb();
  vi.mocked(searchFuelAlongRouteAccounted).mockReset();
});

/** A user whose units and vehicle are set, so onboarding's next step is the last one. */
async function returningDriver() {
  const user = await seedUser();
  await setUnitsPref(user.id, 'metric');
  const vehicle = await addVehicle(user.id, { name: 'Hilux', range_km: 500, is_default: true });
  return { user, vehicle };
}

describe('onboarding: the start_fuel step', () => {
  async function tripAtVehicleStep() {
    const { user, vehicle } = await returningDriver();
    const trip = await createTrip({ userId: user.id, name: 'Spain', vehicleId: vehicle.id });
    const { db } = await testDb();
    await db.update(trips).set({ onboardingState: 'vehicle_new' }).where(eq(trips.id, trip.id));
    return { user, trip };
  }

  it('is asked after a complete vehicle, as the last step, tap-only', async () => {
    const { user, trip } = await tripAtVehicleStep();
    const snap = await getOnboardingSnapshot(trip.id, user.id);
    expect(snap.state).toBe('start_fuel');
    expect(snap.question?.key).toBe('start_fuel');
    expect(snap.question?.kind).toBe('select');
    expect(snap.question?.options?.map((o) => o.value)).toEqual(['full', 'fill_at_start']);
    expect(snap.progress).not.toBeNull();
    expect(snap.progress?.current).toBe(snap.progress?.total);
  });

  it('refuses anything but one of the two options, and stays on the step', async () => {
    const { user, trip } = await tripAtVehicleStep();
    await getOnboardingSnapshot(trip.id, user.id);
    for (const value of ['yep I am full', 'FULL', 1, null]) {
      await expect(
        submitAnswer(trip.id, user.id, { questionKey: 'start_fuel', value }),
      ).rejects.toThrow('Tap one of the two options.');
    }
    const { db } = await testDb();
    const [row] = await db.select().from(trips).where(eq(trips.id, trip.id));
    expect(row.startFuel).toBe('full');
    expect(row.onboardingState).toBe('start_fuel');
  });

  it.each<[StartFuel, string]>([
    ['fill_at_start', 'Find fuel at the start'],
    ['full', 'Yep, full'],
  ])('stores %s and hands off to Penny', async (value, label) => {
    const { user, trip } = await tripAtVehicleStep();
    await getOnboardingSnapshot(trip.id, user.id);
    const result = await submitAnswer(trip.id, user.id, { questionKey: 'start_fuel', value });
    expect(result.didHandoff).toBe(true);
    expect(result.next.state).toBe('done');
    expect(result.answerLabel).toBe(label);

    const { db } = await testDb();
    const [row] = await db.select().from(trips).where(eq(trips.id, trip.id));
    expect(row.startFuel).toBe(value);
    expect(row.onboardingState).toBe('done');

    // The step is recorded like every other: its question, then the answer
    // carrying the widget it was, with the tapped option lit.
    const rows = await db
      .select()
      .from(chatHistory)
      .where(eq(chatHistory.tripId, trip.id))
      .orderBy(asc(chatHistory.seq));
    const q = rows.find((r) => r.kind === 'form_question' && r.content === START_FUEL_QUESTION.label);
    const a = rows.find((r) => r.kind === 'form_answer' && r.content === label);
    expect(q).toBeTruthy();
    expect(a?.formMeta?.selected).toBe(value);
  });
});

// ── Finn ──────────────────────────────────────────────────────────────────
//
// Two 300 km days due north along lng -3.7 (1° of latitude ≈ 111.2 km), on a
// 500 km range. From a full tank day 1 needs no stop at all.

const LNG = -3.7;
const KM_PER_DEG = 111.195;
const latAt = (km: number) => 40 + km / KM_PER_DEG;

function line(fromKm: number, toKm: number) {
  const coordinates: [number, number][] = [];
  for (let km = fromKm; km <= toKm; km += 10) coordinates.push([LNG, latAt(km)]);
  return { type: 'LineString' as const, coordinates };
}

function station(id: string, kmFromTripStart: number): FuelStation {
  return {
    placeId: id,
    lat: latAt(kmFromTripStart),
    lng: LNG,
    name: `Station ${id}`,
    brand: null,
    types: ['gas_station'],
    googleMapsUri: null,
  };
}

// Day 1 has a station 3 km out and one at 150; day 2 has one 30 km in and one
// 180 km in. Every search returns all four: projection drops the other day's
// (they sit far more than 15 km off this day's line).
const STATIONS = [station('d1-early', 3), station('d1-mid', 150), station('d2-early', 330), station('d2-late', 480)];

async function twoDayTrip(startFuel: StartFuel) {
  const { user, vehicle } = await returningDriver();
  const trip = await createTrip({ userId: user.id, name: `North ${startFuel}`, vehicleId: vehicle.id });
  const { db } = await testDb();
  await db.update(trips).set({ onboardingState: 'done', startFuel }).where(eq(trips.id, trip.id));
  const day = (from: number, to: number) =>
    addLeg({
      tripId: trip.id,
      title: 'derived',
      startName: `km ${from}`,
      endName: `km ${to}`,
      startLat: latAt(from),
      startLng: LNG,
      endLat: latAt(to),
      endLng: LNG,
      distanceKm: to - from,
      driveTimeMinutes: 200,
      geometry: line(from, to),
    });
  const day1 = await day(0, 300);
  const day2 = await day(300, 600);
  vi.mocked(searchFuelAlongRouteAccounted).mockResolvedValue(STATIONS);
  return { user, trip, day1, day2 };
}

async function fuelStopsOn(legId: string) {
  const { db } = await testDb();
  return db
    .select({
      placeId: stops.placeId,
      distanceFromStartKm: stops.distanceFromStartKm,
      forcedReason: stops.forcedReason,
    })
    .from(stops)
    .where(and(eq(stops.legId, legId), eq(stops.stopType, 'fuel')))
    .orderBy(asc(stops.distanceFromStartKm));
}

describe('Finn: the starting tank', () => {
  it('"full" is the old behaviour: day 1 fits on the tank, so no stop', async () => {
    const { user, day1 } = await twoDayTrip('full');
    const result = await planFuelStopsForLeg(day1, user.id);
    expect(result).toMatchObject({ status: 'ready', stopsCreated: 0 });
    expect(await fuelStopsOn(day1)).toEqual([]);
  });

  it('"fill_at_start" fills up at the first station of day 1, with its reason', async () => {
    const { user, day1 } = await twoDayTrip('fill_at_start');
    const result = await planFuelStopsForLeg(day1, user.id);
    expect(result).toMatchObject({ status: 'ready', stopsCreated: 1 });
    expect(await fuelStopsOn(day1)).toEqual([
      { placeId: 'd1-early', distanceFromStartKm: 3, forcedReason: { kind: 'trip_start_fill' } },
    ]);
  });

  it('plans the next day from a full tank at that fill-up, and does not fill "at the start" again', async () => {
    const { user, day1, day2 } = await twoDayTrip('fill_at_start');
    await planFuelStopsForLeg(day1, user.id);
    await planFuelStopsForLeg(day2, user.id);
    // 297 km burned since the fill, 203 km of reach: the farthest station
    // inside it is 180 km in. A second start-fill would have taken the one 30
    // km in.
    expect(await fuelStopsOn(day2)).toEqual([
      { placeId: 'd2-late', distanceFromStartKm: 180, forcedReason: null },
    ]);
  });

  it('opening day 2 first still fills up at the start of day 1 (the cascade)', async () => {
    const { user, day1, day2 } = await twoDayTrip('fill_at_start');
    await planFuelStopsForLeg(day2, user.id);
    expect((await fuelStopsOn(day1)).map((s) => s.placeId)).toEqual(['d1-early']);
    expect((await fuelStopsOn(day2)).map((s) => s.placeId)).toEqual(['d2-late']);
  });

  it('a first drive day after a rest day still counts as the start', async () => {
    const { user, vehicle } = await returningDriver();
    const trip = await createTrip({ userId: user.id, name: 'Rest first', vehicleId: vehicle.id });
    const { db } = await testDb();
    await db
      .update(trips)
      .set({ onboardingState: 'done', startFuel: 'fill_at_start' })
      .where(eq(trips.id, trip.id));
    await addLeg({
      tripId: trip.id,
      title: 'derived',
      legType: 'rest',
      startName: 'km 0',
      endName: 'km 0',
      startLat: latAt(0),
      startLng: LNG,
      endLat: latAt(0),
      endLng: LNG,
    });
    const drive = await addLeg({
      tripId: trip.id,
      title: 'derived',
      startName: 'km 0',
      endName: 'km 300',
      startLat: latAt(0),
      startLng: LNG,
      endLat: latAt(300),
      endLng: LNG,
      distanceKm: 300,
      driveTimeMinutes: 200,
      geometry: line(0, 300),
    });
    vi.mocked(searchFuelAlongRouteAccounted).mockResolvedValue(STATIONS);
    await planFuelStopsForLeg(drive, user.id);
    expect((await fuelStopsOn(drive)).map((s) => s.forcedReason)).toEqual([{ kind: 'trip_start_fill' }]);
  });

  it('the itinerary never claims range to spare on an unsourced first day', async () => {
    const { user, trip, day1 } = await twoDayTrip('fill_at_start');
    const before = await getTripFull(trip.id);
    // Unknown tank, read as empty until the fill-up exists: no spare to show.
    expect(before?.legs[0].range_remaining_start_km).toBe(0);

    await planFuelStopsForLeg(day1, user.id);
    const after = await getTripFull(trip.id);
    expect(after?.legs[0].range_remaining_start_km).toBe(500);
  });
});
