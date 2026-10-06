import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { login } from './fixtures/auth';
import {
  anonymousContext,
  bearerContext,
  paidUsage,
  seedAccount,
  send,
  signInWithOtp,
  signedInAccount,
  type SignedInAccount,
} from './fixtures/api';
import { setSubscriptionState } from './fixtures/subscription';
import { seededTripStartISO } from '../src/app/api/test/seedDates';

/**
 * Every API route, and what it refuses.
 *
 * Table-driven over the whole API, as the phone talks to it (bearer token from
 * the real OTP sign-in — e2e/fixtures/api.ts):
 *
 *   - anonymous → 401 (admin drill: 404);
 *   - a malformed body or query → 400, never the 500 a thrown ZodError used to
 *     become;
 *   - a second fixture user ("stranger") on the owner's ids → 403 or 404;
 *   - the routes that can spend Anthropic money, on a blocked account → 402.
 *
 * And the spend half: none of it may cost anything. Every refusal must land
 * BEFORE a paid Anthropic or Google call, so each account's paid-call count
 * (`usage_events`, read through /api/test/seed `paid-usage`) is the same at the
 * end as at the start.
 *
 * The owner's happy-path writes (a route, its link, a task, a stop, viewport
 * time, a position report) are LEFT in place: they are the rows PR #83's
 * column-coverage measurement counts on the preview.
 *
 * Admin routes cannot be called AS an admin from here — the allowlist is one
 * real person — so their malformed-body 400 is proven by errorResponse's unit
 * test (src/server/auth/guards.test.ts), and here only their 401/403.
 */

const RANDOM_UUID = '00000000-0000-4000-8000-00000000dead';

let owner: SignedInAccount;
let stranger: SignedInAccount;
let blocked: SignedInAccount;
let anon: APIRequestContext;
/** The stranger again, signed in on the WEB: admin routes take a cookie only. */
let strangerWeb: BrowserContext;
let ids: { route: string; link: string; task: string; stop: string; strangerRoute: string };
const usageBefore = new Map<string, number>();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  [owner, stranger, blocked] = await Promise.all([signedInAccount(), signedInAccount(), signedInAccount()]);
  anon = await anonymousContext();
  // Admin guards accept the web session cookie and never a bearer token (the
  // app has no admin surface), so "signed in, not an admin" is asked on the web.
  strangerWeb = await browser.newContext();
  await login(await strangerWeb.newPage(), stranger.email);

  // Blocked: a dead trial, comped explicitly off (fixture addresses are on the
  // comp list by design — see fixtures/subscription.ts).
  await setSubscriptionState(blocked.email, { comped: false, createdAtDaysAgo: 30, anthropicSpendUsd: 0 });
  const verdict = await blocked.api.get('/api/me/entitlement');
  expect(((await verdict.json()) as { entitled: boolean }).entitled, 'the blocked fixture is blocked').toBe(false);

  for (const a of [owner, stranger, blocked]) usageBefore.set(a.email, (await paidUsage(a.email)).calls);

  // The owner's rows. Left in place on purpose (see the header).
  const route = await owner.api.post('/api/routes', {
    data: {
      leg_id: owner.legIds[0],
      label: 'Route des Crêtes',
      description: 'The ridge road instead of the A4',
      distance_km: 77,
      surface: 'paved',
      end_lat: 48.0794,
      end_lng: 7.0997,
      end_name: 'Col de la Schlucht',
      end_source: 'manual',
      drive_time_minutes: 95,
      links: [{ url: 'https://www.routedescretes.com', type: 'website', label: 'Official site' }],
    },
  });
  expect(route.status(), await route.text()).toBe(200);
  const routeId = ((await route.json()) as { id: string }).id;

  const link = await owner.api.post(`/api/routes/${routeId}/links`, {
    data: { url: 'https://www.gaiagps.com/map/?loc=10/7.0997/48.0794', type: 'gaia', label: 'Gaia' },
  });
  expect(link.status(), await link.text()).toBe(200);

  const task = await owner.api.post('/api/tasks', {
    data: {
      trip_id: owner.tripId,
      leg_id: owner.legIds[0],
      title: 'Book the Strasbourg campsite',
      priority: 'high',
      reference_url: 'https://www.camping-strasbourg.com',
      reference_label: 'Camping Indigo',
      reference_phone: '+33 3 88 30 19 96',
      due_at: seededTripStartISO(),
    },
  });
  expect(task.status(), await task.text()).toBe(200);

  const stop = await owner.api.post('/api/stops', {
    data: {
      leg_id: owner.legIds[0],
      stop_type: 'other',
      name: 'Boulangerie Paul, Metz',
      lat: 49.1193,
      lng: 6.1757,
      notes: 'Breakfast',
      source: 'user',
    },
  });
  expect(stop.status(), await stop.text()).toBe(200);

  const viewport = await owner.api.post('/api/analytics/viewport-time', {
    data: { deltas: { mobile: 42, tablet: 0, desktop: 0 } },
  });
  expect(viewport.status(), await viewport.text()).toBe(200);

  const position = await owner.api.post(`/api/trips/${owner.tripId}/position`, {
    data: { lat: 48.7, lng: 6.18, place_name: 'Nancy, France' },
  });
  expect(position.status(), await position.text()).toBe(200);

  // The stranger's own route, for the cross-route link delete.
  const strangerRoute = await stranger.api.post('/api/routes', {
    data: { leg_id: stranger.legIds[0], label: 'Stranger road' },
  });
  expect(strangerRoute.status(), await strangerRoute.text()).toBe(200);

  ids = {
    route: routeId,
    link: ((await link.json()) as { id: string }).id,
    task: ((await task.json()) as { id: string }).id,
    stop: ((await stop.json()) as { id: string }).id,
    strangerRoute: ((await strangerRoute.json()) as { id: string }).id,
  };
});

test.afterAll(async () => {
  await anon?.dispose();
  await strangerWeb?.close();
  for (const a of [owner, stranger, blocked]) await a?.api.dispose();
});

/**
 * One row per handler. `path` is built late because the ids exist only after
 * beforeAll. `malformed` is a body (or a path) the schema refuses; `stranger`
 * is what the second user gets on the owner's ids.
 */
interface Case {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: () => string;
  body?: () => unknown;
  /** Anonymous status. Default 401. */
  anon?: number;
  malformed?: { path?: () => string; body?: unknown; status?: number };
  stranger?: number[];
  /** Admin-only: the stranger is asked with a web cookie, which admin guards read. */
  admin?: true;
}

const CASES: Record<string, Case> = {
  // ── admin: 401 anonymous, 403 for any signed-in non-admin ──
  'GET admin/announcements': { method: 'GET', path: () => '/api/admin/announcements', admin: true, stranger: [403] },
  'POST admin/announcements': { method: 'POST', path: () => '/api/admin/announcements', body: () => ({}), admin: true, stranger: [403] },
  'PATCH admin/announcements': { method: 'PATCH', path: () => '/api/admin/announcements', body: () => ({}), admin: true, stranger: [403] },
  'GET admin/jev': { method: 'GET', path: () => '/api/admin/jev', admin: true, stranger: [403] },
  'POST admin/jev': { method: 'POST', path: () => '/api/admin/jev', body: () => ({ mode: 'on' }), admin: true, stranger: [403] },
  'POST admin/jev/user': { method: 'POST', path: () => '/api/admin/jev/user', body: () => ({}), admin: true, stranger: [403] },
  'GET admin/paywall': { method: 'GET', path: () => '/api/admin/paywall', admin: true, stranger: [403] },
  'POST admin/paywall': { method: 'POST', path: () => '/api/admin/paywall', body: () => ({ enabled: false }), admin: true, stranger: [403] },
  'POST admin/paywall/user': { method: 'POST', path: () => '/api/admin/paywall/user', body: () => ({}), admin: true, stranger: [403] },
  'GET admin/penny-lock': { method: 'GET', path: () => '/api/admin/penny-lock', admin: true, stranger: [403] },
  'POST admin/penny-lock': { method: 'POST', path: () => '/api/admin/penny-lock', body: () => ({ locked: true }), admin: true, stranger: [403] },
  'GET admin/promo': { method: 'GET', path: () => '/api/admin/promo', admin: true, stranger: [403] },
  'POST admin/promo': { method: 'POST', path: () => '/api/admin/promo', body: () => ({}), admin: true, stranger: [403] },
  'POST admin/subscription/reactivate': { method: 'POST', path: () => '/api/admin/subscription/reactivate', body: () => ({}), admin: true, stranger: [403] },
  'POST admin/subscription/revoke': { method: 'POST', path: () => '/api/admin/subscription/revoke', body: () => ({}), admin: true, stranger: [403] },
  'GET admin/test-error': { method: 'GET', path: () => '/api/admin/test-error', anon: 404, admin: true, stranger: [404] },
  'GET admin/test-users': { method: 'GET', path: () => '/api/admin/test-users', admin: true, stranger: [403] },
  'POST admin/test-users': { method: 'POST', path: () => '/api/admin/test-users', body: () => ({}), admin: true, stranger: [403] },
  'GET debug/fuel': { method: 'GET', path: () => '/api/debug/fuel', admin: true, stranger: [403] },

  // ── the signed-in user's own surface ──
  'POST analytics/client-error': {
    method: 'POST',
    path: () => '/api/analytics/client-error',
    body: () => ({ code: 'x', phase: 'stream-threw' }),
    malformed: { body: { code: '', phase: 'nope' } },
  },
  'POST analytics/viewport-time': {
    method: 'POST',
    path: () => '/api/analytics/viewport-time',
    body: () => ({ deltas: { mobile: 1, tablet: 0, desktop: 0 } }),
    malformed: { body: { deltas: { mobile: -1 } } },
  },
  'GET announcements/active': { method: 'GET', path: () => '/api/announcements/active' },
  'POST announcements/dismiss': {
    method: 'POST',
    path: () => '/api/announcements/dismiss',
    body: () => ({ announcementId: RANDOM_UUID }),
    malformed: { body: { announcementId: 'not-a-uuid' } },
  },
  'GET me': { method: 'GET', path: () => '/api/me' },
  'GET me/entitlement': { method: 'GET', path: () => '/api/me/entitlement' },
  'GET me/identity': { method: 'GET', path: () => '/api/me/identity' },
  'PATCH me/preferences': {
    method: 'PATCH',
    path: () => '/api/me/preferences',
    body: () => ({ units_pref: 'metric' }),
    malformed: { body: { units_pref: 'furlongs' } },
  },
  // Refused on the confirmation phrase, before anything is deleted.
  'POST me/delete': {
    method: 'POST',
    path: () => '/api/me/delete',
    body: () => ({ confirm: 'nope' }),
    malformed: { body: { confirm: 'please' }, status: 403 },
  },
  'POST promo/redeem': {
    method: 'POST',
    path: () => '/api/promo/redeem',
    body: () => ({ code: 'NOPE' }),
    malformed: { body: { code: '' } },
  },
  'POST support': {
    method: 'POST',
    path: () => '/api/support',
    body: () => ({ message: 'hello' }),
    malformed: { body: { message: '' } },
  },
  'GET vehicles': { method: 'GET', path: () => '/api/vehicles' },
  'POST vehicles': {
    method: 'POST',
    path: () => '/api/vehicles',
    body: () => ({ name: 'x' }),
    malformed: { body: { name: '' } },
  },
  'GET vehicles/[id]': {
    method: 'GET',
    path: () => `/api/vehicles/${owner.vehicleId}`,
    stranger: [404],
  },
  'PATCH vehicles/[id]': {
    method: 'PATCH',
    path: () => `/api/vehicles/${owner.vehicleId}`,
    body: () => ({ name: 'Stolen van' }),
    malformed: { body: { name: '' } },
    stranger: [404],
  },
  'DELETE vehicles/[id]': {
    method: 'DELETE',
    path: () => `/api/vehicles/${owner.vehicleId}`,
    stranger: [404],
  },

  // ── trips ──
  'GET trips': { method: 'GET', path: () => '/api/trips' },
  'POST trips': {
    method: 'POST',
    path: () => '/api/trips',
    body: () => ({ name: 'x' }),
    malformed: { body: { name: '' } },
  },
  'GET trip': {
    method: 'GET',
    path: () => `/api/trip?tripId=${owner.tripId}`,
    malformed: { path: () => '/api/trip?tripId=nope' },
    stranger: [403],
  },
  'PATCH trips/[id]': {
    method: 'PATCH',
    path: () => `/api/trips/${owner.tripId}`,
    body: () => ({ name: 'Hijacked' }),
    malformed: { body: { name: '' } },
    stranger: [403],
  },
  'DELETE trips/[id]': { method: 'DELETE', path: () => `/api/trips/${owner.tripId}`, stranger: [403] },
  'POST trips/[id]/clone': { method: 'POST', path: () => `/api/trips/${owner.tripId}/clone`, stranger: [403] },
  'GET trips/[id]/onboarding': { method: 'GET', path: () => `/api/trips/${owner.tripId}/onboarding`, stranger: [403] },
  'POST trips/[id]/onboarding': {
    method: 'POST',
    path: () => `/api/trips/${owner.tripId}/onboarding`,
    body: () => ({ questionKey: 'trip_date', value: 'next week' }),
    malformed: { body: { questionKey: '', value: { surprise: true } } },
    stranger: [403],
  },
  'POST trips/[id]/position': {
    method: 'POST',
    path: () => `/api/trips/${owner.tripId}/position`,
    body: () => ({ lat: 1, lng: 1 }),
    malformed: { body: { lat: 200, lng: 0 } },
    stranger: [403],
  },
  'GET trips/[id]/turns': {
    method: 'GET',
    path: () => `/api/trips/${owner.tripId}/turns`,
    malformed: { path: () => `/api/trips/${owner.tripId}/turns?key=short` },
    stranger: [403],
  },
  // handoff: true skips the message classifier, so even a request that got
  // past every guard could not spend on the gate; every case here is refused
  // well before that anyway.
  'POST trip/replan': {
    method: 'POST',
    path: () => '/api/trip/replan',
    body: () => ({ tripId: owner.tripId, message: 'Add a day in Colmar', handoff: true }),
    malformed: { body: { tripId: 'nope', message: 'x' } },
    stranger: [403],
  },
  'GET chat': {
    method: 'GET',
    path: () => `/api/chat?tripId=${owner.tripId}`,
    malformed: { path: () => '/api/chat?tripId=nope' },
    stranger: [403],
  },
  'GET pois': {
    method: 'GET',
    path: () => `/api/pois?tripId=${owner.tripId}`,
    malformed: { path: () => '/api/pois?tripId=nope' },
    stranger: [403],
  },

  // ── a day's contents ──
  'POST legs/[id]/fuel-stops': {
    method: 'POST',
    path: () => `/api/legs/${owner.legIds[0]}/fuel-stops`,
    body: () => ({}),
    malformed: { path: () => '/api/legs/nope/fuel-stops' },
    stranger: [403],
  },
  'PATCH legs/[id]/notes': {
    method: 'PATCH',
    path: () => `/api/legs/${owner.legIds[0]}/notes`,
    body: () => ({ notes: ['mine now'] }),
    malformed: { body: { notes: 'not a list' } },
    stranger: [403],
  },
  'GET stops': {
    method: 'GET',
    path: () => `/api/stops?legId=${owner.legIds[0]}`,
    malformed: { path: () => '/api/stops?legId=nope' },
    stranger: [403],
  },
  'POST stops': {
    method: 'POST',
    path: () => '/api/stops',
    body: () => ({ leg_id: owner.legIds[0], stop_type: 'other', name: 'x' }),
    // 'fuel' is refused outright: fuel rows come only from Finn.
    malformed: { body: { leg_id: RANDOM_UUID, stop_type: 'fuel', name: 'Repsol' } },
    stranger: [403],
  },
  'PATCH stops/[id]': {
    method: 'PATCH',
    path: () => `/api/stops/${ids.stop}`,
    body: () => ({ status: 'dismissed' }),
    malformed: { body: { stop_type: 'fuel' } },
    stranger: [403],
  },
  'DELETE stops/[id]': { method: 'DELETE', path: () => `/api/stops/${ids.stop}`, stranger: [403] },
  'POST stops/[id]/select': { method: 'POST', path: () => `/api/stops/${ids.stop}/select`, body: () => ({}), stranger: [403] },
  'POST stops/[id]/swap-primary': {
    method: 'POST',
    path: () => `/api/stops/${ids.stop}/swap-primary`,
    body: () => ({ alt_index: 0 }),
    malformed: { body: { alt_index: -1 } },
    stranger: [403],
  },
  'GET routes': {
    method: 'GET',
    path: () => `/api/routes?legId=${owner.legIds[0]}`,
    malformed: { path: () => '/api/routes?legId=nope' },
    stranger: [403],
  },
  'POST routes': {
    method: 'POST',
    path: () => '/api/routes',
    body: () => ({ leg_id: owner.legIds[0], label: 'x' }),
    malformed: { body: { leg_id: RANDOM_UUID, label: '', end_lat: 200 } },
    stranger: [403],
  },
  'PATCH routes/[id]': {
    method: 'PATCH',
    path: () => `/api/routes/${ids.route}`,
    body: () => ({ label: 'Hijacked' }),
    malformed: { body: { end_lat: 200 } },
    stranger: [403],
  },
  'DELETE routes/[id]': { method: 'DELETE', path: () => `/api/routes/${ids.route}`, stranger: [403] },
  'POST routes/[id]/select': { method: 'POST', path: () => `/api/routes/${ids.route}/select`, body: () => ({}), stranger: [403] },
  'POST routes/[id]/links': {
    method: 'POST',
    path: () => `/api/routes/${ids.route}/links`,
    body: () => ({ url: 'https://example.com' }),
    malformed: { body: { label: 'no url' } },
    stranger: [403],
  },
  'DELETE routes/[id]/links': {
    method: 'DELETE',
    path: () => `/api/routes/${ids.route}/links?linkId=${ids.link}`,
    malformed: { path: () => `/api/routes/${ids.route}/links?linkId=nope` },
    stranger: [403],
  },
  'GET tasks': {
    method: 'GET',
    path: () => `/api/tasks?tripId=${owner.tripId}`,
    malformed: { path: () => '/api/tasks?tripId=nope' },
    stranger: [403],
  },
  'POST tasks': {
    method: 'POST',
    path: () => '/api/tasks',
    body: () => ({ trip_id: owner.tripId, title: 'x' }),
    malformed: { body: { trip_id: RANDOM_UUID, title: '' } },
    stranger: [403],
  },
  'PATCH tasks/[id]': {
    method: 'PATCH',
    path: () => `/api/tasks/${ids.task}`,
    body: () => ({ title: 'Hijacked' }),
    malformed: { body: { title: 42 } },
    stranger: [403],
  },
  'DELETE tasks/[id]': { method: 'DELETE', path: () => `/api/tasks/${ids.task}`, stranger: [403] },
  'GET gpx': {
    method: 'GET',
    path: () => `/api/gpx?legId=${owner.legIds[0]}`,
    malformed: { path: () => '/api/gpx?legId=nope' },
    stranger: [403],
  },
  'POST gpx': {
    method: 'POST',
    path: () => '/api/gpx',
    body: () => ({ legId: owner.legIds[0] }),
    // Not multipart.
    malformed: { body: { legId: RANDOM_UUID } },
  },
  'DELETE gpx/[id]': { method: 'DELETE', path: () => `/api/gpx/${RANDOM_UUID}`, stranger: [404] },
};

/** The routes that can spend Anthropic money: refused 402 on a blocked account. */
const ENTITLED: Record<string, { path: () => string; body: () => unknown }> = {
  'POST trips': { path: () => '/api/trips', body: () => ({ name: 'Blocked trip' }) },
  'POST trips/[id]/clone': { path: () => `/api/trips/${blocked.tripId}/clone`, body: () => ({}) },
  'POST trips/[id]/onboarding': {
    path: () => `/api/trips/${blocked.tripId}/onboarding`,
    body: () => ({ questionKey: 'trip_date', value: 'next week' }),
  },
  'POST trip/replan': {
    path: () => '/api/trip/replan',
    body: () => ({ tripId: blocked.tripId, message: 'Plan my trip', handoff: true }),
  },
};

test.describe('API contracts — anonymous', () => {
  for (const [name, c] of Object.entries(CASES)) {
    test(`${name} → ${c.anon ?? 401} anonymous`, async () => {
      const res = await send(anon, c.method, c.path(), c.body?.());
      expect(res.status(), await res.text()).toBe(c.anon ?? 401);
    });
  }
});

test.describe('API contracts — malformed', () => {
  for (const [name, c] of Object.entries(CASES)) {
    if (!c.malformed) continue;
    const m = c.malformed;
    test(`${name} → ${m.status ?? 400} on a malformed request`, async () => {
      const res = await send(owner.api, c.method, (m.path ?? c.path)(), m.body ?? c.body?.());
      expect(res.status(), await res.text()).toBe(m.status ?? 400);
    });
  }
});

test.describe('API contracts — stranger', () => {
  for (const [name, c] of Object.entries(CASES)) {
    if (!c.stranger) continue;
    test(`${name} → ${c.stranger.join('/')} for another user`, async () => {
      const ctx = c.admin ? strangerWeb.request : stranger.api;
      const res = await send(ctx, c.method, c.path(), c.body?.());
      expect(c.stranger, `${res.status()}: ${await res.text()}`).toContain(res.status());
    });
  }

  test("your own tripId with someone else's legId reads nothing (routes, tasks, gpx)", async () => {
    for (const path of ['/api/routes', '/api/tasks', '/api/gpx']) {
      const res = await stranger.api.get(`${path}?tripId=${stranger.tripId}&legId=${owner.legIds[0]}`);
      expect(res.status(), `${path}: ${await res.text()}`).toBe(404);
    }
  });

  test("deleting someone else's link through your own route is a 404, and the link survives", async () => {
    const res = await stranger.api.delete(`/api/routes/${ids.strangerRoute}/links?linkId=${ids.link}`);
    expect(res.status(), await res.text()).toBe(404);
    const routes = await owner.api.get(`/api/routes?legId=${owner.legIds[0]}`);
    const list = (await routes.json()) as { id: string; links: { id: string }[] }[];
    const mine = list.find((r) => r.id === ids.route);
    expect(mine?.links.map((l) => l.id)).toContain(ids.link);
  });

  test("a task can't be filed against a leg from another of your trips' days", async () => {
    const res = await stranger.api.post('/api/tasks', {
      data: { trip_id: stranger.tripId, leg_id: owner.legIds[0], title: 'x' },
    });
    expect([403, 404]).toContain(res.status());
  });
});

test.describe('API contracts — paywall', () => {
  for (const [name, c] of Object.entries(ENTITLED)) {
    test(`${name} → 402 on a blocked account`, async () => {
      const res = await blocked.api.post(c.path(), { data: c.body() });
      expect(res.status(), await res.text()).toBe(402);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBeTruthy();
    });
  }
});

test.describe('API contracts — happy paths left in place', () => {
  test("the owner's route, link, task and stop read back", async () => {
    const routes = (await (await owner.api.get(`/api/routes?legId=${owner.legIds[0]}`)).json()) as {
      id: string;
      links: { id: string }[];
    }[];
    expect(routes.find((r) => r.id === ids.route)?.links.length).toBeGreaterThanOrEqual(2);
    const tasks = (await (await owner.api.get(`/api/tasks?tripId=${owner.tripId}`)).json()) as { id: string }[];
    expect(tasks.map((t) => t.id)).toContain(ids.task);
    const stops = (await (await owner.api.get(`/api/stops?legId=${owner.legIds[0]}`)).json()) as {
      id: string;
      stop_type: string;
    }[];
    expect(stops.find((s) => s.id === ids.stop)?.stop_type).toBe('other');
  });

  test("the owner's vehicle takes a fuel type", async () => {
    const res = await owner.api.patch(`/api/vehicles/${owner.vehicleId}`, { data: { fuel_type: 'diesel' } });
    expect(res.status(), await res.text()).toBe(200);
    expect(((await res.json()) as { fuel_type: string | null }).fuel_type).toBe('diesel');
  });

  /**
   * The columns no affordable flow writes (a failed fuel search, a continuity
   * gap, Finn's alternates, a failed turn with an image, the tools' position
   * and declared range…), seeded as fixture data and read back through the
   * API the app uses. Left in place for the column-coverage measurement.
   */
  test('the coverage fixture round-trips through GET /api/trip', async () => {
    const seeded = await seedAccount({ coverageColumns: true });
    const api = await bearerContext(await signInWithOtp(seeded.email));
    try {
      const res = await api.get(`/api/trip?tripId=${seeded.tripId}`);
      expect(res.status(), await res.text()).toBe(200);
      const trip = (await res.json()) as {
        legs: {
          id: string;
          continuity_warning: string | null;
          fuel_plan_error: string | null;
          stops: { stop_type: string; alternatives: { name: string }[] | null; source_url: string | null }[];
        }[];
      };
      const [day1, day2] = trip.legs;
      const fuel = day1.stops.find((st) => st.stop_type === 'fuel');
      expect(fuel?.alternatives?.[0]?.name).toBe('Total Access Reims');
      expect(fuel?.source_url).toMatch(/^https:\/\/www\.google\.com\/maps/);
      expect(day2.continuity_warning).toBeTruthy();
      expect(day2.fuel_plan_error).toBeTruthy();
    } finally {
      await api.dispose();
    }
  });

  /**
   * The upload writes the file to the app's own filesystem (src/lib/gpx.ts),
   * which is read-only on Vercel. If this fails on the preview, that is a
   * finding to report, not something to paper over here.
   */
  test('GPX upload stores a trail', async () => {
    const res = await owner.api.post('/api/gpx', {
      multipart: {
        file: {
          name: 'ridge.gpx',
          mimeType: 'application/gpx+xml',
          buffer: Buffer.from(
            '<?xml version="1.0"?><gpx version="1.1" creator="e2e"><trk><name>Ridge</name><trkseg>' +
              '<trkpt lat="48.07" lon="7.09"/><trkpt lat="48.08" lon="7.10"/></trkseg></trk></gpx>',
          ),
        },
        tripId: owner.tripId,
        legId: owner.legIds[0],
      },
    });
    expect(res.status(), await res.text()).toBe(201);
  });
});

test.describe('API contracts — spend', () => {
  test('no refusal above cost anything: each account made no paid call', async () => {
    for (const a of [owner, stranger, blocked]) {
      const after = await paidUsage(a.email);
      expect(after.calls, `${a.email} paid calls`).toBe(usageBefore.get(a.email));
    }
  });
});
