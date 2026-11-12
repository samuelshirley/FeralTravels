import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A Penny turn's dispatch is ONE database transaction.
 *
 * The pre-dispatch gates (lib/penny/turnAtomicity.ts) stop a batch they can
 * judge in advance. This covers what they cannot: an action that passes every
 * gate and then THROWS inside dispatch (a stop on a route that is gone, a DB
 * error). Before, every action ahead of it had already been written, so the
 * trip was left half-edited under Penny's "Done". Now the whole batch rolls
 * back and the reply carries the same server-written correction.
 *
 * What must NOT roll back: accounting. A usage_events row written during the
 * turn records something that happened (spend, a logged idea) whether or not
 * the trip changes.
 *
 * Through the REAL replan route over PGlite, with the REAL repos, the REAL
 * Google accounting wrapper and the transaction scope the production client
 * uses (harness.ts wraps PGlite exactly as client.ts wraps postgres-js). Only
 * auth, spend limits, the model loop and the raw Directions HTTP call are
 * stand-ins.
 */

const m = vi.hoisted(() => ({
  userId: '',
  actions: [] as unknown[],
  directionsCalls: 0,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/auth/index', () => ({ auth: vi.fn() }));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireEntitledUser: vi.fn(async () => ({
    id: m.userId,
    email: null,
    isAdmin: false,
    verdict: { state: 'trial', entitled: true },
  })),
}));
vi.mock('@/server/payments', async (orig) => ({
  ...(await orig<typeof import('@/server/payments')>()),
  assertPennyGateOpen: vi.fn(async () => undefined),
  dailyReplanCapUsd: () => 5,
}));
vi.mock('@/server/ipLimit', () => ({ assertIpAllowed: vi.fn(async () => undefined) }));
vi.mock('@/server/pennyFallbackAlert', () => ({ reportPennyFallback: vi.fn() }));
vi.mock('@/lib/google/directions', async (orig) => {
  const real = await orig<typeof import('@/lib/google/directions')>();
  const { haversineKm } = await import('@/lib/penny/geo');
  return {
    ...real,
    getDirections: vi.fn(async (o: { lat: number; lng: number }, d: { lat: number; lng: number }) => {
      m.directionsCalls += 1;
      const km = Math.round(haversineKm(o.lat, o.lng, d.lat, d.lng) * 1.2 * 10) / 10;
      return {
        ok: true,
        distance_km: km,
        drive_time_minutes: Math.round(km * 0.6),
        polyline_points: [
          [o.lat, o.lng],
          [d.lat, d.lng],
        ],
        start_address: '',
        end_address: '',
        warnings: [],
        start_location: o,
        end_location: d,
        cached: false,
      };
    }),
  };
});
vi.mock('@/lib/claude', async (orig) => {
  const real = await orig<typeof import('@/lib/claude')>();
  const replanStream = vi.fn(async function* () {
    const response = 'Done — updated your route.';
    yield { kind: 'text', chunk: response };
    yield {
      kind: 'done',
      result: {
        response,
        validatedActions: m.actions,
        retryCount: 0,
        failedValidations: [],
        truncated: false,
        leakRetryCount: 0,
        leakSanitized: false,
        fallback: null,
        extractIntentCalled: false,
        feasibilityVerdict: null,
        fuelPlanRan: false,
        toolTrace: [[]],
        turnTrace: { prompt: 'test', calls: [] },
      },
    };
  });
  return { ...real, replanStream };
});

import { asc, eq } from 'drizzle-orm';
import { legs, tasks, usageEvents, vehicles } from '@/server/db/schema';
import { addLeg, createTrip } from '@/server/repos/trips';
import { recordAiConsent } from '@/server/repos/users';
import { addVehicle } from '@/server/repos/vehicles';
import { POST } from '@/app/api/trip/replan/route';
import { jsonRequest } from '@/test/routeHarness';
import { resetDb, seedUser, testDb } from './harness';

const GIRONA = { name: 'Girona, Spain', lat: 41.98328, lng: 2.82471 };
const LLOSA = { name: 'la Llosa, Spain', lat: 39.76506, lng: -0.20327 };
const CULLAR = { name: 'Cúllar, Spain', lat: 37.58569, lng: -2.54246 };
const TARIFA = { name: 'Tarifa, Spain', lat: 36.01432, lng: -5.60445 };
const TRIGUEROS = { name: 'Trigueros, Spain', lat: 37.32895, lng: -6.82163 };

const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.ANTHROPIC_API_KEY = 'test-key-never-called';
  m.directionsCalls = 0;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

async function seedTrip() {
  const user = await seedUser();
  await recordAiConsent(user.id);
  const trip = await createTrip({
    userId: user.id,
    name: `Tx ${crypto.randomUUID().slice(0, 8)}`,
    startDate: '2026-11-14',
  });
  m.userId = user.id;
  const ids: string[] = [];
  for (const [i, [a, b]] of ([
    [GIRONA, LLOSA],
    [LLOSA, CULLAR],
    [CULLAR, TARIFA],
  ] as const).entries()) {
    ids.push(
      await addLeg({
        tripId: trip.id,
        title: `${a.name} → ${b.name}`,
        startName: a.name,
        endName: b.name,
        startLat: a.lat,
        startLng: a.lng,
        endLat: b.lat,
        endLng: b.lng,
        sortOrder: i,
      }),
    );
  }
  return { tripId: trip.id, ids };
}

async function send(tripId: string) {
  const res = await POST(
    jsonRequest('/api/trip/replan', 'POST', {
      tripId,
      message: 'Carry on to Trigueros and rename day one',
      images: [],
      handoff: false,
      idempotencyKey: `test-${crypto.randomUUID()}`,
    }),
  );
  expect(res.status).toBe(200);
  return (await res.text())
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>)
    .find((f) => f.kind === 'applied') as Record<string, unknown>;
}

async function snapshot(tripId: string) {
  const { db } = await testDb();
  const rows = await db.select().from(legs).where(eq(legs.tripId, tripId)).orderBy(asc(legs.sortOrder));
  const taskRows = await db.select().from(tasks).where(eq(tasks.tripId, tripId));
  return {
    legs: rows.map((r) => [r.id, r.sortOrder, r.title, r.label, r.startLat, r.endLat, r.geometry]),
    tasks: taskRows.length,
  };
}

/** Actions 1, 2 and 4 are valid; action 3 names a task that does not exist and throws in dispatch. */
function batchThatThrowsAtThree(ids: string[]) {
  return [
    {
      name: 'add_leg',
      input: {
        title: 'Tarifa → Trigueros',
        leg_type: 'drive',
        start_name: TARIFA.name,
        end_name: TRIGUEROS.name,
        start_lat: TARIFA.lat,
        start_lng: TARIFA.lng,
        end_lat: TRIGUEROS.lat,
        end_lng: TRIGUEROS.lng,
      },
    },
    { name: 'update_leg', input: { leg_id: ids[0], data: { label: 'Coast run' } } },
    { name: 'submit_idea', input: { idea: 'Show ferry crossings' } },
    {
      name: 'update_task',
      input: { task_id: '00000000-0000-4000-8000-000000000000', data: { done: true } },
    },
  ];
}

describe('a Penny turn dispatches inside one transaction', () => {
  it('an action that throws mid-dispatch rolls back every action before it', async () => {
    const { tripId, ids } = await seedTrip();
    const before = await snapshot(tripId);
    m.actions = batchThatThrowsAtThree(ids);

    const applied = await send(tripId);

    expect(await snapshot(tripId)).toEqual(before);
    expect(applied.appliedCount).toBe(0);
    expect(applied.persistFailedCount).toBe(3);
    expect(String(applied.response)).toMatch(
      /⚠️ Correction: none of these changes were saved — .*Your plan is unchanged\.$/,
    );
  });

  it('accounting survives the rollback: the usage row written inside the turn is kept', async () => {
    const { tripId, ids } = await seedTrip();
    m.actions = batchThatThrowsAtThree(ids);

    await send(tripId);

    const { db } = await testDb();
    const idea = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.provider, 'penny:user-idea'));
    expect(idea.map((r) => r.errorMessage)).toEqual(['Show ferry crossings']);
  });

  it('a rolled-back turn makes no paid Google call at all', async () => {
    const { tripId, ids } = await seedTrip();
    m.actions = batchThatThrowsAtThree(ids);
    await send(tripId);
    expect(m.directionsCalls).toBe(0);
  });

  it('a clean batch still commits whole, and the new leg gets its geometry after commit', async () => {
    const { tripId, ids } = await seedTrip();
    m.actions = batchThatThrowsAtThree(ids).slice(0, 3);

    const applied = await send(tripId);
    const after = await snapshot(tripId);

    expect(applied.persistFailedCount).toBe(0);
    expect(after.legs.map((l) => l[2])).toEqual([
      'Girona, Spain → la Llosa, Spain',
      'la Llosa, Spain → Cúllar, Spain',
      'Cúllar, Spain → Tarifa, Spain',
      'Tarifa, Spain → Trigueros, Spain',
    ]);
    expect(after.legs[0][3]).toBe('Coast run');
    expect(after.legs[3][6]).toMatchObject({ type: 'LineString' });
  });

  it('report_position re-routes the next drive AFTER commit, not inside the transaction', async () => {
    // applyTripProgress re-routes the upcoming leg through Directions. Inside
    // the turn transaction that call is forbidden, so the route defers it.
    const { tripId, ids } = await seedTrip();
    const VALENCIA = { lat: 39.4699, lng: -0.3763 };
    m.actions = [
      {
        name: 'report_position',
        input: { lat: VALENCIA.lat, lng: VALENCIA.lng, place_name: 'Valencia, Spain', next_leg_id: ids[1] },
      },
    ];

    const applied = await send(tripId);
    const { db } = await testDb();
    const [leg] = await db.select().from(legs).where(eq(legs.id, ids[1]));

    expect(applied.persistFailedCount).toBe(0);
    expect([leg.startLat, leg.startLng, leg.title]).toEqual([
      VALENCIA.lat,
      VALENCIA.lng,
      'Valencia, Spain → Cúllar, Spain',
    ]);
    expect(leg.geometry).toMatchObject({ type: 'LineString' });
    expect(m.directionsCalls).toBeGreaterThan(0);
  });

  it("a repo's own transaction inside the turn is a savepoint: it rolls back with the turn", async () => {
    // updateVehicle opens db.transaction itself. Inside a turn it must join the
    // turn (a savepoint), not commit on its own ahead of a later failure.
    const { tripId } = await seedTrip();
    const vehicle = await addVehicle(m.userId, { name: 'Sprinter 4x4', range_km: 700, fuel_type: 'petrol' });
    m.actions = [
      { name: 'update_vehicle', input: { data: { fuel_type: 'diesel' } } },
      {
        name: 'update_task',
        input: { task_id: '00000000-0000-4000-8000-000000000000', data: { done: true } },
      },
    ];

    const applied = await send(tripId);
    const { db } = await testDb();
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, vehicle.id));

    expect(applied.persistFailedCount).toBe(2);
    expect(row.fuelType).toBe('petrol');
  });

  it('…and commits with it when the batch is clean', async () => {
    const { tripId } = await seedTrip();
    const vehicle = await addVehicle(m.userId, { name: 'Sprinter 4x4', range_km: 700, fuel_type: 'petrol' });
    m.actions = [{ name: 'update_vehicle', input: { data: { fuel_type: 'diesel' } } }];

    const applied = await send(tripId);
    const { db } = await testDb();
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, vehicle.id));

    expect(applied.persistFailedCount).toBe(0);
    expect(row.fuelType).toBe('diesel');
  });
});
