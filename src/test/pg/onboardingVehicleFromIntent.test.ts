import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A vehicle named in the opening message is the vehicle the trip uses.
 *
 * REPORTED (2026-11-10, appletest): "Munich to Nordkapp and back… Sprinter 4x4,
 * 700km range" produced a plan on the account's saved Hilux (500 km), and
 * nothing said so. Two causes, both shown here against the real code path:
 *   1. the scan's forced tool schema had no vehicle field, so the name was
 *      dropped before the server ever saw it;
 *   2. the range WAS read, but `vehicle_new` attached the account's only
 *      vehicle to the trip, found it complete, and finished onboarding — the
 *      stated range went nowhere.
 *
 * Through the REAL onboarding POST route, the REAL intent scan and the REAL
 * repos over PGlite. Only auth and the Anthropic SDK are stand-ins: the SDK
 * returns the forced `record_onboarding_fields` tool call a model would, so
 * nothing reaches Anthropic.
 */

const m = vi.hoisted(() => ({
  userId: '',
  /** The scan tool's input, as the model would fill it. */
  scan: {} as Record<string, unknown>,
  calls: [] as Array<{ tools?: Array<{ name: string; input_schema: unknown }> }>,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/auth/index', () => ({ auth: vi.fn() }));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireUserId: vi.fn(async () => m.userId),
  requireEntitledUser: vi.fn(async () => ({
    id: m.userId,
    email: null,
    isAdmin: false,
    verdict: { state: 'trial', entitled: true },
  })),
}));
vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      create: vi.fn(async (req: { tools?: Array<{ name: string; input_schema: unknown }> }) => {
        m.calls.push(req);
        return {
          content: [{ type: 'tool_use', id: 't1', name: 'record_onboarding_fields', input: m.scan }],
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      }),
    };
  }
  return { default: Anthropic };
});

import { eq } from 'drizzle-orm';
import { trips, vehicles } from '@/server/db/schema';
import { createTrip } from '@/server/repos/trips';
import { recordAiConsent, setUnitsPref } from '@/server/repos/users';
import { addVehicle } from '@/server/repos/vehicles';
import { POST as onboardingPOST } from '@/app/api/trips/[id]/onboarding/route';
import { resetDb, seedUser, testDb } from './harness';

const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(async () => {
  await resetDb();
  m.calls = [];
  process.env.ANTHROPIC_API_KEY = 'test-key-never-called';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

/** A tool call that read origin, date and pace — the vehicle fields vary per test. */
function scanned(vehicle: Record<string, unknown>) {
  return {
    origin_place: 'Munich',
    start_date_phrase: '2026-12-10',
    daily_drive_hours: 6,
    range_km: null,
    vehicle_name: null,
    range_value: null,
    range_unit: null,
    ...vehicle,
  };
}

async function user(opts: { units?: 'metric' | 'imperial'; hilux?: boolean } = {}) {
  const u = await seedUser();
  await recordAiConsent(u.id);
  if (opts.units) await setUnitsPref(u.id, opts.units);
  if (opts.hilux) await addVehicle(u.id, { name: 'Hilux', range_km: 500 });
  m.userId = u.id;
  const trip = await createTrip({ userId: u.id, name: `Veh ${crypto.randomUUID().slice(0, 8)}` });
  const { db } = await testDb();
  await db.update(trips).set({ onboardingState: 'trip_intent' }).where(eq(trips.id, trip.id));
  return { userId: u.id, tripId: trip.id };
}

async function answer(tripId: string, questionKey: string, value: unknown) {
  const res = await onboardingPOST(
    new Request(`https://example.test/api/trips/${tripId}/onboarding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questionKey, value }),
    }),
    { params: { id: tripId } },
  );
  const body = (await res.json()) as {
    next: {
      state: string;
      question: { key: string; defaultValue?: string } | null;
      progress?: { current: number; total: number } | null;
    };
    note?: string;
    error?: string;
  };
  expect(res.status, body.error).toBe(200);
  return body;
}

const FIRST = 'Munich to Nordkapp and back, leaving 2026-12-10, 6 h a day. Sprinter 4x4, 700km range.';

async function tripVehicle(tripId: string) {
  const { db } = await testDb();
  const [t] = await db.select().from(trips).where(eq(trips.id, tripId));
  if (!t.vehicleId) return null;
  const [v] = await db.select().from(vehicles).where(eq(vehicles.id, t.vehicleId));
  return { name: v.name, rangeKm: v.rangeKm, isDefault: v.isDefault };
}

async function allVehicles(userId: string) {
  const { db } = await testDb();
  const rows = await db.select().from(vehicles).where(eq(vehicles.userId, userId));
  return rows.map((v) => [v.name, v.rangeKm, v.isDefault]).sort();
}

describe('the scan asks the model for the vehicle', () => {
  it('its forced tool schema has a nullable vehicle name, range value and range unit', async () => {
    const { tripId } = await user({ units: 'metric', hilux: true });
    m.scan = scanned({});
    await answer(tripId, 'trip_intent', FIRST);
    const tool = m.calls[0].tools!.find((t) => t.name === 'record_onboarding_fields')!;
    const props = (tool.input_schema as { properties: Record<string, { type: unknown }> }).properties;
    expect(props.vehicle_name?.type).toEqual(['string', 'null']);
    expect(props.range_value?.type).toEqual(['number', 'null']);
    expect(props.range_unit?.type).toEqual(['string', 'null']);
  });
});

describe('a vehicle named in the first message is the one the trip uses', () => {
  it('REGRESSION (appletest): a saved Hilux does not override the Sprinter the driver named', async () => {
    const { userId, tripId } = await user({ units: 'metric', hilux: true });
    m.scan = scanned({ vehicle_name: 'Sprinter 4x4', range_value: 700, range_unit: 'km' });

    const res = await answer(tripId, 'trip_intent', FIRST);

    expect(await tripVehicle(tripId)).toEqual({ name: 'Sprinter 4x4', rangeKm: 700, isDefault: false });
    // The account's default is unchanged; the Sprinter is saved beside it.
    expect(await allVehicles(userId)).toEqual([
      ['Hilux', 500, true],
      ['Sprinter 4x4', 700, false],
    ]);
    expect(res.next.state).toBe('done');
    expect(res.note).toContain('Sprinter 4x4');
    expect(res.note).toContain('700 km');
  });

  it('naming a vehicle the account already has uses that row, not a duplicate', async () => {
    const { userId, tripId } = await user({ units: 'metric', hilux: true });
    m.scan = scanned({ vehicle_name: 'hilux' });

    await answer(tripId, 'trip_intent', FIRST);

    expect(await tripVehicle(tripId)).toEqual({ name: 'Hilux', rangeKm: 500, isDefault: true });
    expect(await allVehicles(userId)).toEqual([['Hilux', 500, true]]);
  });

  it('no vehicle yet + name and range → created as the default, and the vehicle step is never asked', async () => {
    const { userId, tripId } = await user({ units: 'metric' });
    m.scan = scanned({ vehicle_name: 'Sprinter 4x4', range_value: 700, range_unit: 'km' });

    const res = await answer(tripId, 'trip_intent', FIRST);

    expect(res.next.state).toBe('done');
    expect(await allVehicles(userId)).toEqual([['Sprinter 4x4', 700, true]]);
    expect(await tripVehicle(tripId)).toEqual({ name: 'Sprinter 4x4', rangeKm: 700, isDefault: true });
  });

  it('no vehicle yet + name only → only the range half is asked, and answering it completes the vehicle', async () => {
    const { userId, tripId } = await user({ units: 'metric' });
    m.scan = scanned({ vehicle_name: 'Sprinter 4x4' });

    const res = await answer(tripId, 'trip_intent', FIRST);
    expect(res.next.state).toBe('vehicle_new');
    expect(res.next.question?.key).toBe('range_km');

    const done = await answer(tripId, 'range_km', '650');
    expect(done.next.state).toBe('done');
    expect(await allVehicles(userId)).toEqual([['Sprinter 4x4', 650, true]]);
  });

  it('a range stated in miles is converted on the server', async () => {
    const { tripId } = await user({ units: 'metric' });
    m.scan = scanned({ vehicle_name: 'Sprinter 4x4', range_value: 450, range_unit: 'mi' });

    await answer(tripId, 'trip_intent', FIRST);

    expect(await tripVehicle(tripId)).toMatchObject({ name: 'Sprinter 4x4', rangeKm: 724 });
  });

  it('a range with no unit follows the user’s units', async () => {
    const { tripId } = await user({ units: 'imperial' });
    m.scan = scanned({ vehicle_name: 'Sprinter 4x4', range_value: 450, range_unit: null });

    await answer(tripId, 'trip_intent', FIRST);

    expect(await tripVehicle(tripId)).toMatchObject({ rangeKm: 724 });
  });

  it('a range with no unit and no units chosen yet is not guessed: the range half is asked', async () => {
    const { tripId } = await user();
    m.scan = scanned({ vehicle_name: 'Sprinter 4x4', range_value: 450, range_unit: null });

    const r1 = await answer(tripId, 'trip_intent', FIRST);
    expect(r1.next.state).toBe('units_pick');
    const r2 = await answer(tripId, 'units_pref', 'metric');
    expect(r2.next.question?.key).toBe('range_km');
    expect(await tripVehicle(tripId)).toEqual({ name: 'Sprinter 4x4', rangeKm: null, isDefault: true });
  });

  it('an out-of-band range is dropped by the server, not written', async () => {
    const { tripId } = await user({ units: 'metric' });
    m.scan = scanned({ vehicle_name: 'Sprinter 4x4', range_value: 9000, range_unit: 'km' });

    const res = await answer(tripId, 'trip_intent', FIRST);

    expect(res.next.question?.key).toBe('range_km');
    expect(await tripVehicle(tripId)).toMatchObject({ rangeKm: null });
  });

  it('a stated range for a vehicle the account already has is written to it, and said back', async () => {
    const { userId, tripId } = await user({ units: 'metric', hilux: true });
    m.scan = scanned({ vehicle_name: 'Hilux', range_value: 600, range_unit: 'km' });

    const res = await answer(tripId, 'trip_intent', FIRST);

    expect(await allVehicles(userId)).toEqual([['Hilux', 600, true]]);
    expect(res.note).toContain('driving the Hilux (600 km on a tank)');
  });

  it('the receipt speaks the user’s units', async () => {
    const { tripId } = await user({ units: 'imperial' });
    m.scan = scanned({ vehicle_name: 'Sprinter 4x4', range_value: 450, range_unit: 'mi' });
    const res = await answer(tripId, 'trip_intent', FIRST);
    expect(res.note).toContain('driving the Sprinter 4x4 (450 mi on a tank)');
  });

  it('the step counter does not count a vehicle step the opening message already answered', async () => {
    // New user: units still to choose. Named vehicle + range ⇒ units is the
    // LAST step, so it must read "N of N".
    const { tripId } = await user();
    m.scan = scanned({ vehicle_name: 'Sprinter 4x4', range_value: 700, range_unit: 'km' });
    const res = await answer(tripId, 'trip_intent', FIRST);
    expect(res.next.state).toBe('units_pick');
    expect(res.next.progress).toEqual({ current: 2, total: 2 });
  });

  it('…and counts exactly one for the range half when only the name was given', async () => {
    const { tripId } = await user();
    m.scan = scanned({ vehicle_name: 'Sprinter 4x4' });
    const r1 = await answer(tripId, 'trip_intent', FIRST);
    expect(r1.next.progress).toEqual({ current: 2, total: 3 });
    const r2 = await answer(tripId, 'units_pref', 'metric');
    expect(r2.next.question?.key).toBe('range_km');
    expect(r2.next.progress).toEqual({ current: 3, total: 3 });
  });
});
