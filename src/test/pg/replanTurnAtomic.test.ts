import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A Penny turn is all-or-nothing for the trip.
 *
 * INCIDENT (trip 65972b73, 2026-11-10): "go up the Portuguese coast instead".
 * Penny queued 11 delete_leg + 11 add_leg. The pre-dispatch contiguity gate
 * blocked all 11 deletes, the 11 adds dispatched anyway, and continuity repair
 * then re-chained the four old legs that should have been deleted onto their
 * new neighbours: Tarifa→Tarifa 0 km, Trigueros→Trigueros 0 km, Lagos→Lagos
 * 3 km and Girona→Écija 1,007 km. Penny's reply said "Done… exactly 10 days";
 * the plan said 22 days.
 *
 * Through the REAL replan route over PGlite, with the REAL repos, gate,
 * schedule rebuild and continuity repair. Only auth, the spend limits, the
 * model loop and Google Directions are stand-ins (Directions returns a
 * straight line at 1.2× the great-circle distance, so nothing reaches Google).
 *
 * The legs are trip 65972b73's turn-1 plan as it was served to the browser,
 * not as stored after the corruption. Écija, Socuéllamos and Benicarló carry
 * town-centre coordinates: their stored values were not captured.
 */

const m = vi.hoisted(() => ({
  userId: '',
  actions: [] as unknown[],
  /** Simulates extract_trip_intent having run with this feasibility verdict. */
  feasibility: null as null | 'over_budget' | 'ok',
  replanStream: vi.fn(),
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
vi.mock('@/server/google/accounted', async (orig) => {
  const real = await orig<typeof import('@/server/google/accounted')>();
  const { haversineKm } = await import('@/lib/penny/geo');
  return {
    ...real,
    getDirectionsAccounted: vi.fn(
      async (o: { lat: number; lng: number }, d: { lat: number; lng: number }) => {
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
      },
    ),
  };
});
vi.mock('@/lib/claude', async (orig) => {
  const real = await orig<typeof import('@/lib/claude')>();
  m.replanStream.mockImplementation(async function* () {
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
        extractIntentCalled: m.feasibility !== null,
        feasibilityVerdict: m.feasibility,
        fuelPlanRan: false,
        toolTrace: [[]],
        turnTrace: { prompt: 'test', calls: [] },
      },
    };
  });
  return { ...real, replanStream: m.replanStream };
});

import { asc, eq } from 'drizzle-orm';
import { legs } from '@/server/db/schema';
import { addLeg, createTrip, repairLegContinuity } from '@/server/repos/trips';
import { recordAiConsent } from '@/server/repos/users';
import { POST } from '@/app/api/trip/replan/route';
import { jsonRequest } from '@/test/routeHarness';
import { haversineKm } from '@/lib/penny/geo';
import { resetDb, seedUser, testDb } from './harness';

type P = { name: string; lat: number; lng: number };
const GIRONA: P = { name: 'Girona, Spain', lat: 41.98328, lng: 2.82471 };
const LLOSA: P = { name: 'la Llosa, Spain', lat: 39.76506, lng: -0.20327 };
const INTERMEDIATE: P = { name: 'Intermediate stop', lat: 38.5, lng: -1.5 };
const CULLAR: P = { name: 'Cúllar, Spain', lat: 37.58569, lng: -2.54246 };
const TARIFA: P = { name: 'Tarifa, Spain', lat: 36.01432, lng: -5.60445 };
const TRIGUEROS: P = { name: 'Trigueros, Spain', lat: 37.32895, lng: -6.82163 };
const LAGOS: P = { name: 'Lagos, Portugal', lat: 37.10877, lng: -8.67593 };
const ECIJA: P = { name: 'Écija, Spain', lat: 37.5417, lng: -5.0826 };
const SOCUELLAMOS: P = { name: 'Socuéllamos, Spain', lat: 39.2939, lng: -2.7942 };
const BENICARLO: P = { name: 'Benicarló, Spain', lat: 40.4167, lng: 0.4253 };
const LISBON: P = { name: 'Lisbon, Portugal', lat: 38.7223, lng: -9.1393 };
const FIGUERES: P = { name: 'Figueres, Spain', lat: 42.2667, lng: 2.9614 };

/** Turn 1 of trip 65972b73, in order. `rest` is the Tarifa base day. */
const TURN1: Array<[P, P, 'drive' | 'rest']> = [
  [GIRONA, LLOSA, 'drive'],
  [LLOSA, INTERMEDIATE, 'drive'],
  [INTERMEDIATE, CULLAR, 'drive'],
  [CULLAR, TARIFA, 'drive'],
  [TARIFA, TARIFA, 'rest'],
  [TARIFA, TRIGUEROS, 'drive'],
  [TRIGUEROS, LAGOS, 'drive'],
  [LAGOS, ECIJA, 'drive'],
  [ECIJA, SOCUELLAMOS, 'drive'],
  [SOCUELLAMOS, BENICARLO, 'drive'],
  [BENICARLO, GIRONA, 'drive'],
];

const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.ANTHROPIC_API_KEY = 'test-key-never-called';
  m.feasibility = null;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

async function seedTrip(): Promise<{ tripId: string; ids: string[] }> {
  const user = await seedUser();
  await recordAiConsent(user.id);
  const trip = await createTrip({
    userId: user.id,
    name: `Atomic ${crypto.randomUUID().slice(0, 8)}`,
    startDate: '2026-11-14',
  });
  m.userId = user.id;
  const ids: string[] = [];
  for (const [i, [a, b, type]] of TURN1.entries()) {
    ids.push(
      await addLeg({
        tripId: trip.id,
        title: `${a.name} → ${b.name}`,
        legType: type,
        startName: a.name,
        endName: b.name,
        startLat: a.lat,
        startLng: a.lng,
        endLat: b.lat,
        endLng: b.lng,
        distanceKm: type === 'rest' ? 0 : Math.round(haversineKm(a.lat, a.lng, b.lat, b.lng) * 1.2),
        sortOrder: i,
      }),
    );
  }
  return { tripId: trip.id, ids };
}

function addLegAction(a: P, b: P, extra: Record<string, unknown> = {}) {
  return {
    name: 'add_leg',
    input: {
      title: `${a.name} → ${b.name}`,
      leg_type: 'drive',
      start_name: a.name,
      end_name: b.name,
      start_lat: a.lat,
      start_lng: a.lng,
      end_lat: b.lat,
      end_lng: b.lng,
      ...extra,
    },
  };
}
const deleteLegAction = (id: string) => ({ name: 'delete_leg', input: { leg_id: id } });

async function send(tripId: string) {
  const res = await POST(
    jsonRequest('/api/trip/replan', 'POST', {
      tripId,
      message: 'Go up the Portuguese coast instead',
      images: [],
      handoff: false,
      idempotencyKey: `test-${crypto.randomUUID()}`,
    }),
  );
  expect(res.status).toBe(200);
  const frames = (await res.text())
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
  return frames.find((f) => f.kind === 'applied') as Record<string, unknown>;
}

async function tripLegs(tripId: string) {
  const { db } = await testDb();
  return db.select().from(legs).where(eq(legs.tripId, tripId)).orderBy(asc(legs.sortOrder));
}

/** Every leg starts within 1 km of where the previous one ended. */
function gaps(rows: Awaited<ReturnType<typeof tripLegs>>): string[] {
  const out: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1];
    const c = rows[i];
    const km = haversineKm(p.endLat!, p.endLng!, c.startLat!, c.startLng!);
    if (km > 1) out.push(`${p.title} ⇢ ${c.title} (${Math.round(km)} km)`);
  }
  return out;
}

/** A drive day that starts where it ends — the 0 km "Tarifa → Tarifa" shape. */
function sameStartEndDrives(rows: Awaited<ReturnType<typeof tripLegs>>): string[] {
  return rows
    .filter((r) => r.legType === 'drive')
    .filter((r) => haversineKm(r.startLat!, r.startLng!, r.endLat!, r.endLng!) < 1)
    .map((r) => r.title);
}

describe('a Penny turn never half-applies to the trip', () => {
  it('REGRESSION: a mid-route detour anchored with after_leg_id applies whole and stays contiguous', async () => {
    // Replace Lagos → Écija with Lagos → Lisbon → Écija. On main the gate
    // simulated the adds at the END of the trip, saw a Lagos ⇢ Écija hole,
    // blocked the delete, dispatched the adds, and repair turned the surviving
    // old leg into "Écija → Écija".
    const { tripId, ids } = await seedTrip();
    const lagosEcija = ids[7];
    const trigLagos = ids[6];
    m.actions = [
      deleteLegAction(lagosEcija),
      addLegAction(LAGOS, LISBON, { after_leg_id: trigLagos }),
      addLegAction(LISBON, ECIJA),
    ];

    const applied = await send(tripId);
    const rows = await tripLegs(tripId);

    expect(applied.persistFailedCount).toBe(0);
    expect(rows.map((r) => r.id)).not.toContain(lagosEcija);
    expect(sameStartEndDrives(rows)).toEqual([]);
    expect(gaps(rows)).toEqual([]);
    expect(rows.map((r) => r.title)).toEqual([
      'Girona, Spain → la Llosa, Spain',
      'la Llosa, Spain → Intermediate stop',
      'Intermediate stop → Cúllar, Spain',
      'Cúllar, Spain → Tarifa, Spain',
      expect.stringContaining('Tarifa'),
      'Tarifa, Spain → Trigueros, Spain',
      'Trigueros, Spain → Lagos, Portugal',
      'Lagos, Portugal → Lisbon, Portugal',
      'Lisbon, Portugal → Écija, Spain',
      'Écija, Spain → Socuéllamos, Spain',
      'Socuéllamos, Spain → Benicarló, Spain',
      'Benicarló, Spain → Girona, Spain',
    ]);
  });

  it('a batch the gate rejects changes NOTHING, and the reply says so', async () => {
    // A genuine hole: delete a mid-route day with no bridge, plus an add the
    // trip would otherwise accept. On main the delete was blocked and the add
    // landed anyway — half a turn.
    const { tripId, ids } = await seedTrip();
    const before = await tripLegs(tripId);
    m.actions = [deleteLegAction(ids[6]), addLegAction(GIRONA, FIGUERES)];

    const applied = await send(tripId);
    const after = await tripLegs(tripId);

    expect(after.map((r) => [r.id, r.sortOrder, r.startLat, r.startLng, r.title])).toEqual(
      before.map((r) => [r.id, r.sortOrder, r.startLat, r.startLng, r.title]),
    );
    expect(applied.appliedCount).toBe(0);
    expect(applied.persistFailedCount).toBe(2);
    expect(String(applied.response)).toContain('Your plan is unchanged');
  });

  it('an over-budget plan keeps its deletes too: the feasibility gate rejects the whole batch', async () => {
    // On main the feasibility gate skipped the add_legs and let the same
    // plan's delete_legs through — the trip lost its tail and gained nothing.
    const { tripId, ids } = await seedTrip();
    const before = await tripLegs(tripId);
    m.feasibility = 'over_budget';
    m.actions = [
      deleteLegAction(ids[9]),
      deleteLegAction(ids[10]),
      addLegAction(SOCUELLAMOS, GIRONA),
    ];

    const applied = await send(tripId);
    const after = await tripLegs(tripId);

    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(applied.appliedCount).toBe(0);
    expect(applied.persistFailedCount).toBe(3);
    expect(String(applied.response)).toContain('exceeds your time budget. Your plan is unchanged');
  });
});

describe('continuity repair never re-chains a leg the turn tried to delete', () => {
  it('leaves a frozen leg exactly as it was, and still repairs the others', async () => {
    // The post-dispatch shape of the incident: new Lagos → Lisbon → Écija sits
    // in front of the old Lagos → Écija the turn tried (and failed) to delete.
    const { tripId, ids } = await seedTrip();
    const trigLagos = ids[6];
    const oldLagosEcija = ids[7];
    await addLeg({
      tripId, title: 'x', startName: LAGOS.name, endName: LISBON.name,
      startLat: LAGOS.lat, startLng: LAGOS.lng, endLat: LISBON.lat, endLng: LISBON.lng,
      afterLegId: trigLagos,
    });
    const lisbonEcija = await addLeg({
      tripId, title: 'x', startName: LISBON.name, endName: ECIJA.name,
      startLat: LISBON.lat, startLng: LISBON.lng, endLat: ECIJA.lat, endLng: ECIJA.lng,
    });
    // A second, unrelated drift the repair SHOULD still fix: Écija → Socuéllamos
    // starting 100 km off.
    const { db } = await testDb();
    await db.update(legs).set({ startLat: ECIJA.lat + 0.9 }).where(eq(legs.id, ids[8]));

    const before = (await tripLegs(tripId)).find((r) => r.id === oldLagosEcija)!;
    const repaired = await repairLegContinuity(tripId, { frozenLegIds: new Set([oldLagosEcija]) });
    const rows = await tripLegs(tripId);
    const frozenAfter = rows.find((r) => r.id === oldLagosEcija)!;

    expect(repaired.map((r) => r.legId)).not.toContain(oldLagosEcija);
    expect([frozenAfter.startLat, frozenAfter.startLng, frozenAfter.title, frozenAfter.distanceKm]).toEqual([
      before.startLat, before.startLng, before.title, before.distanceKm,
    ]);
    expect(sameStartEndDrives(rows)).toEqual([]);
    // Unfrozen legs are still chained.
    expect(repaired.map((r) => r.legId)).toContain(ids[8]);
    expect(rows.map((r) => r.id).indexOf(lisbonEcija)).toBeLessThan(rows.map((r) => r.id).indexOf(oldLagosEcija));
  });
});
