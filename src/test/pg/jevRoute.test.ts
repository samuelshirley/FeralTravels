import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Jev route measurement, end to end, through the REAL replan route over
 * PGlite: the real message gate (its free rules — every message here is let
 * through by an allow rule, so no classifier and no Anthropic call), the real
 * Jev module (with `fetch` stubbed to a TypeSafe-shaped answer), the real turn
 * record, the real dispatch, and the real ledger rows. Only auth, the spend
 * limits and the model loop are stand-ins: `replanStream` ends on the result
 * claude.ts would build for the turn under test, pointing at a REAL
 * `provider: 'anthropic'` row whose cost the measurement must read back.
 *
 * What it pins:
 *  - compare mode asks Jev the route question for a v2 account, and the row
 *    is tied to the turn the message started;
 *  - when the turn ends, what Penny did is recorded on that row — tool names,
 *    counts, the truth, the day — and NOTHING the driver wrote;
 *  - /admin's numbers come from those rows, with "dollars avoided" read from
 *    the turn's own cost row, not estimated;
 *  - a version-1 account is never sent to Jev at all;
 *  - no message is routed away from Penny: every turn runs.
 */

const m = vi.hoisted(() => ({
  userId: '',
  /** The terminal result the next model loop ends on. */
  result: null as Record<string, unknown> | null,
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
vi.mock('@/lib/claude', async (orig) => {
  const real = await orig<typeof import('@/lib/claude')>();
  m.replanStream.mockImplementation(async function* () {
    yield { kind: 'text', chunk: 'Done.' };
    yield { kind: 'done', result: m.result };
  });
  return { ...real, replanStream: m.replanStream };
});

import { eq } from 'drizzle-orm';
import { legs, pennyTurns, stops, trips, usageEvents } from '@/server/db/schema';
import { createTrip } from '@/server/repos/trips';
import { recordAiConsent } from '@/server/repos/users';
import { logAnthropicUsage, microcentsToDollars } from '@/server/repos/usage';
import { getJevRouteStats, invalidateJevSwitch, setGlobalJevMode } from '@/server/repos/jev';
import { PENNY_MODEL } from '@/lib/models';
import { POST } from '@/app/api/trip/replan/route';
import { jsonRequest } from '@/test/routeHarness';
import { resetDb, seedUser, testDb } from './harness';

const LINK = 'https://maps.app.goo.gl/AbCdEfGh123';
/** "stop" is trip vocabulary: the free rules let it through. */
const ADD_MESSAGE = `add this stop to day 2 ${LINK} the secret campsite Zyxwv`;
const FUEL_MESSAGE = 'swap that fuel stop for a different one, the Qwertz station is shut';

const savedKey = process.env.ANTHROPIC_API_KEY;

function routeAnswer(choice: string) {
  const probabilities: Record<string, number> = {
    add_pasted_place: 0.01,
    replace_fuel_stop: 0.01,
    off_topic: 0.01,
    needs_penny: 0.01,
  };
  probabilities[choice] = 0.97;
  return { type: 'choice', choice, probabilities };
}

let fetchMock: ReturnType<typeof vi.fn>;
function jevAnswers(choice: string) {
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).startsWith('https://api.typesafe.ai/')) {
      return new Response(
        JSON.stringify({ model: 'jev-1.13.0', answers: { route: routeAnswer(choice) }, usage: { input_tokens: 71, output_tokens: 0 } }),
        { status: 200 },
      );
    }
    // Anything else (a re-route after a dispatched change) is not under test.
    throw new TypeError(`network disabled in this test: ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.ANTHROPIC_API_KEY = 'test-key-never-called';
  vi.stubEnv('JEV_BASE_URL', 'https://api.typesafe.ai');
  vi.stubEnv('JEV_API_KEY', 'test-key');
  vi.stubEnv('JEV_MODEL', 'jev-1.13.0');
  vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('CI', '');
  await setGlobalJevMode('compare');
  invalidateJevSwitch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  invalidateJevSwitch();
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

/** A v2 (or v1) account owning a 3-day trip; day 2 carries one Finn fuel stop. */
async function setup(consentVersion: 1 | 2 = 2) {
  const user = await seedUser();
  await recordAiConsent(user.id, new Date(), consentVersion);
  const trip = await createTrip({ userId: user.id, name: `Route ${crypto.randomUUID().slice(0, 8)}` });
  const { db } = await testDb();
  await db.update(trips).set({ startDateParsed: '2026-11-12' }).where(eq(trips.id, trip.id));
  const legIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const [leg] = await db
      .insert(legs)
      .values({ tripId: trip.id, sortOrder: i, title: `Day ${i + 1}`, startName: `A${i}`, endName: `B${i}` })
      .returning({ id: legs.id });
    legIds.push(leg.id);
  }
  const [fuel] = await db
    .insert(stops)
    .values({ legId: legIds[1], stopType: 'fuel', name: 'Fuel stop', status: 'option', source: 'google' })
    .returning({ id: stops.id });
  m.userId = user.id;
  return { userId: user.id, tripId: trip.id, legIds, fuelStopId: fuel.id };
}

/** A real cost row for the turn, as claude.ts writes it once per turn. */
async function pennyCostRow(userId: string, tripId: string): Promise<number> {
  const id = await logAnthropicUsage({
    userId,
    tripId,
    model: PENNY_MODEL,
    inputTokens: 4_000,
    outputTokens: 600,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 24_000,
  });
  return id!;
}

function result(patch: Record<string, unknown>) {
  return {
    response: 'Done.',
    validatedActions: [],
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
    turnTrace: { prompt_hash: 'test', calls: [] },
    usageEventId: null,
    ...patch,
  };
}

async function send(tripId: string, message: string) {
  const res = await POST(
    jsonRequest('/api/trip/replan', 'POST', {
      tripId,
      message,
      images: [],
      handoff: false,
      idempotencyKey: `test-${crypto.randomUUID()}`,
    }),
  );
  expect(res.status).toBe(200);
  await res.text(); // drain the stream: the turn runs to its end inside it
}

async function jevRows() {
  const { db } = await testDb();
  return db.select().from(usageEvents).where(eq(usageEvents.provider, 'jev'));
}

describe('a pasted Maps link added to a named day', () => {
  it('records Jev’s route, the turn’s truth, the day, and the measured cost — and no user text', async () => {
    const { userId, tripId, legIds } = await setup();
    jevAnswers('add_pasted_place');
    const costId = await pennyCostRow(userId, tripId);
    m.result = result({
      validatedActions: [
        { name: 'add_stop', input: { leg_id: legIds[1], data: { stop_type: 'other', name: 'Zyxwv campsite', lat: null, lng: null } } },
      ],
      toolTrace: [['add_stop'], []],
      usageEventId: costId,
    });

    await send(tripId, ADD_MESSAGE);

    // Penny ran — nothing was routed away from her.
    expect(m.replanStream).toHaveBeenCalledTimes(1);
    const { db } = await testDb();
    const [turn] = await db.select().from(pennyTurns).where(eq(pennyTurns.tripId, tripId));
    expect(turn.status).toBe('done');
    // And her add_stop landed.
    expect((await db.select().from(stops).where(eq(stops.legId, legIds[1]))).map((s) => s.name)).toContain(
      'Zyxwv campsite',
    );

    // One Jev call, the route question alone (the free rules settled the tier).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(Object.keys(body.questions)).toEqual(['route']);

    const rows = await jevRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ success: true, inputTokens: 71, costMicrocents: 0 });
    expect(rows[0].meta).toMatchObject({
      mode: 'compare',
      gateBy: 'allow_rule',
      route: 'add_pasted_place',
      routeConfident: true,
      pennyTurnId: turn.id,
      turnStatus: 'done',
      truth: 'add_pasted_place',
      toolCounts: { add_stop: 1 },
      appliedCounts: { add_stop: 1 },
      mapsLinkCount: 1,
      dayParseKind: 'day_number',
      parsedDay: 2,
      addedDays: [2],
      dayMatch: true,
      pennyUsageEventId: costId,
    });
    // Nothing the driver wrote — not the link, not the place, not a word.
    const stored = JSON.stringify(rows[0]);
    for (const secret of ['Zyxwv', 'maps.app.goo.gl', 'AbCdEfGh123', 'secret campsite']) {
      expect(stored).not.toContain(secret);
    }

    // /admin: precision, coverage and dollars avoided, read from the cost row.
    const [cost] = await db.select().from(usageEvents).where(eq(usageEvents.id, costId));
    const stats = await getJevRouteStats(7);
    const add = stats.intents.find((i) => i.route === 'add_pasted_place')!;
    expect(add).toMatchObject({ routedConfident: 1, correctConfident: 1, truthCount: 1, costedRows: 1 });
    expect(add.avoidedUsd).toBeCloseTo(microcentsToDollars(cost.costMicrocents!), 10);
    expect(add.avoidedUsd).toBeGreaterThan(0);
    expect(stats).toMatchObject({ compared: 1, answered: 1, graded: 1, ungraded: 0 });
    expect(stats.day).toEqual({ graded: 1, matched: 1, byKind: { day_number: 1 } });
    expect(stats.avgInputTokens).toBe(71);
  });

  it('Jev said needs_penny for that same turn: graded wrong-route, $0 avoided', async () => {
    const { userId, tripId, legIds } = await setup();
    jevAnswers('needs_penny');
    const costId = await pennyCostRow(userId, tripId);
    m.result = result({
      validatedActions: [
        { name: 'add_stop', input: { leg_id: legIds[1], data: { stop_type: 'other', name: 'Spot', lat: null, lng: null } } },
      ],
      toolTrace: [['add_stop'], []],
      usageEventId: costId,
    });
    await send(tripId, ADD_MESSAGE);
    const stats = await getJevRouteStats(7);
    const add = stats.intents.find((i) => i.route === 'add_pasted_place')!;
    expect(add).toMatchObject({ truthCount: 1, routedConfident: 0, correctConfident: 0, avoidedUsd: 0 });
    expect(stats.intents.find((i) => i.route === 'needs_penny')).toMatchObject({ routedConfident: 1, correctConfident: 0 });
  });
});

describe('a different fuel station', () => {
  it('a turn that deleted the fuel stop and re-ran Finn is graded replace_fuel_stop — its type read before the delete', async () => {
    const { userId, tripId, fuelStopId } = await setup();
    jevAnswers('replace_fuel_stop');
    const costId = await pennyCostRow(userId, tripId);
    m.result = result({
      validatedActions: [{ name: 'delete_stop', input: { stop_id: fuelStopId } }],
      toolTrace: [['delete_stop', 'plan_fuel_stops'], []],
      fuelPlanRan: true,
      usageEventId: costId,
    });
    await send(tripId, FUEL_MESSAGE);

    const { db } = await testDb();
    expect(await db.select().from(stops).where(eq(stops.id, fuelStopId))).toEqual([]); // really deleted
    const [row] = await jevRows();
    expect(row.meta).toMatchObject({
      route: 'replace_fuel_stop',
      truth: 'replace_fuel_stop',
      fuelStopDeletes: 1,
      otherStopEdits: 0,
      fuelPlanRan: true,
      dayParseKind: null,
    });
    expect(JSON.stringify(row)).not.toContain('Qwertz');
    const fuel = (await getJevRouteStats(7)).intents.find((i) => i.route === 'replace_fuel_stop')!;
    expect(fuel).toMatchObject({ routedConfident: 1, correctConfident: 1, costedRows: 1 });
    expect(fuel.avoidedUsd).toBeGreaterThan(0);
  });
});

describe('a turn that failed', () => {
  it('is recorded as errored and left out of the grading, not counted as pending', async () => {
    const { tripId } = await setup();
    jevAnswers('replace_fuel_stop');
    m.result = null; // the loop ends with no result: the route marks the turn as an error
    await send(tripId, FUEL_MESSAGE);
    const [row] = await jevRows();
    expect(row.meta).toMatchObject({ turnStatus: 'error', truth: null });
    const stats = await getJevRouteStats(7);
    expect(stats).toMatchObject({ graded: 0, ungraded: 0, erroredTurns: 1 });
  });
});

describe('consent', () => {
  it('a version-1 account: compare mode on, and Jev is never called', async () => {
    const { userId, tripId, legIds } = await setup(1);
    jevAnswers('add_pasted_place');
    m.result = result({
      validatedActions: [
        { name: 'add_stop', input: { leg_id: legIds[1], data: { stop_type: 'other', name: 'Spot', lat: null, lng: null } } },
      ],
      toolTrace: [['add_stop'], []],
      usageEventId: await pennyCostRow(userId, tripId),
    });
    await send(tripId, ADD_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await jevRows()).toEqual([]);
    expect(m.replanStream).toHaveBeenCalledTimes(1);
  });
});

describe('no rows yet', () => {
  it('reads as zeros with nothing graded — /admin says so rather than inventing a number', async () => {
    const stats = await getJevRouteStats(7);
    expect(stats).toMatchObject({ compared: 0, answered: 0, graded: 0, avgInputTokens: null });
    for (const i of stats.intents) expect(i).toMatchObject({ routedConfident: 0, truthCount: 0, avoidedUsd: 0 });
  });
});
