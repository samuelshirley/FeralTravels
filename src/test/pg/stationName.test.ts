import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A fuel station's name, on a tap (Sam, 2026-11-11). Google's terms (§3.2.3)
 * forbid caching business names, so the name is fetched fresh by the stop's
 * `place_id` and never stored — not in a column, not in a usage row.
 *
 * Through the REAL `GET /api/stops/:id/place-name` route, the REAL accounted
 * Google wrapper and the REAL repos over PGlite. Only auth and the HTTP call to
 * Google are stand-ins: `fetch` is stubbed and records what would have gone out.
 */

const NAME = 'Repsol Librilla A-7';
const PLACE = 'ChIJN-4JNefXWw0RoSJmAD56BX4';

const m = vi.hoisted(() => ({
  userId: '',
  isAdmin: false,
  state: 'trial' as string,
  calls: [] as Array<{ url: string; headers: Record<string, string> }>,
  respond: { status: 200, body: '' },
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
    isAdmin: m.isAdmin,
    verdict: { state: m.state, entitled: true },
  })),
}));

import { eq } from 'drizzle-orm';
import { stops, usageEvents } from '@/server/db/schema';
import { addLeg, createTrip } from '@/server/repos/trips';
import { addStop } from '@/server/repos/stops';
import { getUserUsageSummary, logUsageEvent } from '@/server/repos/usage';
import { GET } from '@/app/api/stops/[id]/place-name/route';
import { rawQuery, resetDb, seedUser, testDb } from './harness';

const savedKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

beforeEach(async () => {
  await resetDb();
  m.calls = [];
  m.isAdmin = false;
  m.state = 'trial';
  m.respond = { status: 200, body: JSON.stringify({ displayName: { text: NAME, languageCode: 'es' } }) };
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = 'test-key-never-sent';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      m.calls.push({ url: String(url), headers: init.headers });
      return new Response(m.respond.body, { status: m.respond.status });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  else process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = savedKey;
});

async function fuelStop(opts: { placeId?: string | null; type?: 'fuel' | 'other' } = {}) {
  const user = await seedUser();
  m.userId = user.id;
  const trip = await createTrip({ userId: user.id, name: `St ${crypto.randomUUID().slice(0, 8)}` });
  const legId = await addLeg({ tripId: trip.id, title: 'A → B', startLat: 38.5, startLng: -1.5, endLat: 37.5, endLng: -2.5, sortOrder: 0 });
  const stop = await addStop({
    leg_id: legId,
    stop_type: opts.type ?? 'fuel',
    name: 'Fuel stop',
    lat: 37.885,
    lng: -1.36,
    distance_from_start_km: 89,
    source: 'google',
    place_id: opts.placeId === undefined ? PLACE : opts.placeId,
  });
  return { userId: user.id, tripId: trip.id, stopId: String(stop.id) };
}

async function get(stopId: string) {
  const res = await GET(new Request(`https://example.test/api/stops/${stopId}/place-name`), { params: { id: stopId } });
  return { status: res.status, cache: res.headers.get('cache-control'), body: (await res.json()) as Record<string, unknown> };
}

async function placesRows(userId: string) {
  const { db } = await testDb();
  return (await db.select().from(usageEvents).where(eq(usageEvents.userId, userId))).filter(
    (r) => r.provider === 'google-places',
  );
}

describe('a fuel station name on a tap', () => {
  it('fetches displayName by place_id — field mask exactly displayName — and returns it, no-store', async () => {
    const { stopId } = await fuelStop();
    const res = await get(stopId);
    expect(res).toMatchObject({ status: 200, cache: 'no-store', body: { name: NAME } });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].url).toBe(`https://places.googleapis.com/v1/places/${PLACE}`);
    expect(m.calls[0].headers['X-Goog-FieldMask']).toBe('displayName');
  });

  it('logs the call and its Pro cost — and the name appears in no column of any table', async () => {
    const { userId, stopId } = await fuelStop();
    await get(stopId);

    const rows = await placesRows(userId);
    expect(rows.map((r) => [r.model, r.requests, r.costMicrocents, r.success, r.errorMessage])).toEqual([
      ['place-details-pro', 1, 1_700_000, true, null],
    ]);
    const { db } = await testDb();
    const [stop] = await db.select().from(stops).where(eq(stops.id, stopId));
    expect(stop.name).toBe('Fuel stop');
    // Every text/json column of every table: the name is nowhere.
    const hits = await rawQuery<{ t: string }>(
      `select table_name as t from information_schema.columns
        where table_schema = 'public' and data_type in ('text','character varying','jsonb','json')`,
    );
    for (const { t } of hits) {
      const found = await rawQuery<{ n: number }>(
        `select count(*)::int as n from "${t}" as x where x::text ilike $1`,
        [`%${NAME}%`],
      );
      expect(found[0].n, t).toBe(0);
    }
  });

  it('counts toward the daily $ cap, and NOT as a Penny request for the hourly cap', async () => {
    const { userId, stopId } = await fuelStop();
    await logUsageEvent({ userId, provider: 'anthropic:replan', requests: 1, success: true });
    await get(stopId);
    const hour = await getUserUsageSummary(userId, 1);
    expect(hour.requests).toBe(1); // the Penny call only
    expect(Number(hour.microcents)).toBe(1_700_000); // the lookup's cost is in
  });

  it('refuses once the daily $ cap is spent, without calling Google', async () => {
    const { userId, stopId } = await fuelStop();
    // A trial's cap is $0.50.
    await logUsageEvent({ userId, provider: 'anthropic', requests: 1, success: true });
    const { db } = await testDb();
    await db.update(usageEvents).set({ costMicrocents: 60_000_000 }).where(eq(usageEvents.userId, userId));
    const res = await get(stopId);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('station_name_cap_reached');
    expect(m.calls).toHaveLength(0);
  });

  it('a Google failure is a 502 with a code, logged by status only, and still stores nothing', async () => {
    const { userId, stopId } = await fuelStop();
    m.respond = { status: 500, body: `{"error":"boom ${NAME}"}` };
    const res = await get(stopId);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('station_name_unavailable');
    const rows = await placesRows(userId);
    expect(rows.map((r) => [r.success, r.errorMessage])).toEqual([[false, 'Place details failed: HTTP 500']]);
  });

  it("another user's stop is refused without calling Google", async () => {
    const { stopId } = await fuelStop();
    m.userId = (await seedUser()).id;
    const res = await get(stopId);
    expect(res.status).toBe(403);
    expect(m.calls).toHaveLength(0);
  });

  it('a stop that is not a fuel stop, or has no place id, is a 404 without calling Google', async () => {
    const other = await fuelStop({ type: 'other' });
    expect((await get(other.stopId)).status).toBe(404);
    const noId = await fuelStop({ placeId: null });
    expect((await get(noId.stopId)).status).toBe(404);
    expect(m.calls).toHaveLength(0);
  });

  it('a malformed id is a 400', async () => {
    await fuelStop();
    expect((await get('not-a-uuid')).status).toBe(400);
  });
});

