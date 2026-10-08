import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/trip/replan, end to end over real Postgres: a question turn that
 * called hold_for_confirmation SAVES its writes and applies nothing, and the
 * driver's next "yup" applies them with no model call — through the same
 * pipeline, including the plan-ready card when the question was asked on the
 * handoff turn (trip 9a3df982 asked its first question exactly there).
 *
 * Penny is `replanStream`, scripted per test from a queue; an empty queue
 * THROWS, and so does the Anthropic SDK, so a "yes" that reached the model
 * fails the test rather than passing quietly. Everything before the turn
 * record (auth, caps, breaker, per-IP limit) is mocked open; the message gate
 * is a spy, so the test can show a staged "yes" never reaches it. Google is
 * stubbed — add_leg asks Directions for the leg's geometry.
 */

const m = vi.hoisted(() => ({
  userId: '',
  penny: [] as unknown[],
  replanCalls: 0,
  gateMessage: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/auth/index', () => ({ auth: vi.fn() }));
vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: () => {
        throw new Error('the Anthropic client must not be called in this test');
      },
    };
  },
}));
vi.mock('@/lib/claude', () => ({
  replanStream: async function* () {
    m.replanCalls += 1;
    const next = m.penny.shift();
    if (!next) throw new Error('Penny (replanStream) was called with nothing scripted');
    yield { kind: 'done', result: next };
  },
}));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireEntitledUser: vi.fn(async () => ({ id: m.userId, isAdmin: false, verdict: { state: 'subscribed' } })),
}));
vi.mock('@/server/payments', async (orig) => ({
  ...(await orig<typeof import('@/server/payments')>()),
  assertPennyGateOpen: vi.fn(async () => undefined),
  dailyReplanCapUsd: () => 5,
}));
vi.mock('@/server/ipLimit', () => ({ assertIpAllowed: vi.fn(async () => undefined) }));
vi.mock('@/server/messageGate', () => ({ gateMessage: m.gateMessage }));
const directions = vi.hoisted(() => async () => ({
  ok: true as const,
  distance_km: 433.7,
  drive_time_minutes: 285,
  polyline_points: [
    [41.98328, 2.82471],
    [42.3, 1.4],
    [42.64937, -0.0596],
  ],
  start_address: 'Girona, Spain',
  end_address: 'Torla-Ordesa, Spain',
  start_location: { lat: 41.98328, lng: 2.82471 },
  end_location: { lat: 42.64937, lng: -0.0596 },
  warnings: [],
  cached: false,
}));
vi.mock('@/server/google/accounted', () => ({
  getDirectionsAccounted: directions,
  geocodePlaceAccounted: vi.fn(),
  searchFuelAlongRouteAccounted: vi.fn(),
}));
vi.mock('@/lib/google/directions', async (orig) => ({
  ...(await orig<typeof import('@/lib/google/directions')>()),
  getDirections: directions,
}));

import { eq } from 'drizzle-orm';
import { POST } from '@/app/api/trip/replan/route';
import { chatHistory, legs, pennyTurns } from '@/server/db/schema';
import { createTrip } from '@/server/repos/trips';
import { resetDb, seedUser, testDb } from './harness';

beforeEach(async () => {
  await resetDb();
  m.penny = [];
  m.replanCalls = 0;
  m.gateMessage.mockReset();
  m.gateMessage.mockResolvedValue({ tier: 'T1', by: 'allow_rule', reason: 'test', blocked: false, message: null, lockedUntil: null });
  process.env.ANTHROPIC_API_KEY = 'test-key-never-used';
});

const QUESTION =
  "Two quick clarifications: for Ordesa I'd go with the visitor center in Torla-Ordesa, and Tabernas the town itself. Both good?";

/** What Penny's held question turn returns: one add_leg, held for the yes. */
function heldTurn(): Record<string, unknown> {
  return {
    response: QUESTION,
    validatedActions: [
      {
        name: 'add_leg',
        input: {
          title: 'Girona → Ordesa y Monte Perdido (Torla-Ordesa)',
          leg_type: 'drive',
          start_name: 'Girona',
          end_name: 'Ordesa y Monte Perdido (Torla-Ordesa)',
          start_lat: 41.98328,
          start_lng: 2.82471,
          end_lat: 42.64937,
          end_lng: -0.0596,
          distance_km: 433.7,
          drive_time_minutes: 285,
        },
      },
    ],
    retryCount: 0,
    failedValidations: [],
    truncated: false,
    leakRetryCount: 0,
    leakSanitized: false,
    extractIntentCalled: false,
    fuelPlanRan: false,
    feasibilityVerdict: null,
    toolTrace: [['resolve_place', 'get_route'], ['add_leg', 'hold_for_confirmation'], []],
    turnTrace: { prompt_hash: 'test', calls: [] },
    acceptance: null,
    held: true,
    holdQuestion: 'Both good?',
    tripIntent: null,
    droppedPlaces: [],
  };
}

/** A plain Penny reply that changes nothing. */
function plainTurn(response: string): Record<string, unknown> {
  return { ...heldTurn(), response, validatedActions: [], held: false, holdQuestion: null, toolTrace: [[]] };
}

async function send(tripId: string, message: string, handoff = false) {
  const res = await POST(
    new Request('http://localhost/api/trip/replan', {
      method: 'POST',
      body: JSON.stringify({ tripId, message, handoff, idempotencyKey: crypto.randomUUID() }),
    }),
  );
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
  const applied = events.find((e) => e.kind === 'applied');
  if (!applied) throw new Error(`no applied event: ${text.slice(0, 500)}`);
  return applied;
}

async function setup() {
  const user = await seedUser();
  m.userId = user.id;
  const trip = await createTrip({ userId: user.id, name: 'Spain loop', startDate: '2026-10-10' });
  return { user, trip };
}

async function legCount(tripId: string) {
  const { db } = await testDb();
  return (await db.select().from(legs).where(eq(legs.tripId, tripId))).length;
}

async function chat(tripId: string) {
  const { db } = await testDb();
  return db
    .select({ role: chatHistory.role, kind: chatHistory.kind, content: chatHistory.content })
    .from(chatHistory)
    .where(eq(chatHistory.tripId, tripId))
    .orderBy(chatHistory.seq);
}

async function turns(tripId: string) {
  const { db } = await testDb();
  return db.select().from(pennyTurns).where(eq(pennyTurns.tripId, tripId)).orderBy(pennyTurns.createdAt);
}

describe('POST /api/trip/replan — hold for confirmation', () => {
  it('a held question turn saves its writes and applies none of them', async () => {
    const { trip } = await setup();
    m.penny.push(heldTurn());

    const applied = await send(trip.id, 'plan a national park loop from Girona', true);

    expect(await legCount(trip.id)).toBe(0);
    expect(applied).toMatchObject({ held: true, heldCount: 1, appliedCount: 0, validatedQueuedCount: 0, planReady: false });
    const [questionTurn] = await turns(trip.id);
    const stage = (questionTurn.resultMeta as { stagedPlan?: { actions: unknown[]; handoff: boolean } }).stagedPlan;
    expect(stage?.actions).toHaveLength(1);
    expect(stage?.handoff).toBe(true);
    // No "trip is planned" card over a question.
    expect((await chat(trip.id)).some((r) => r.kind === 'plan_ready')).toBe(false);
  });

  it('"yup" applies them with no model call — and, on a handoff question, gets the first-build card', async () => {
    const { trip } = await setup();
    m.penny.push(heldTurn());
    await send(trip.id, 'plan a national park loop from Girona', true);

    const applied = await send(trip.id, 'yup');

    // Penny was called once — for the question — and never for the yes.
    expect(m.replanCalls).toBe(1);
    // The staged yes is not judged by the gate (the handoff never was).
    expect(m.gateMessage).not.toHaveBeenCalled();
    expect(await legCount(trip.id)).toBe(1);
    expect(applied).toMatchObject({ appliedCount: 1, planReady: true, modelCalls: 0, response: 'Done — saved as proposed.' });
    expect(applied.planSummary).not.toBeNull();

    const rows = await chat(trip.id);
    const card = rows.findIndex((r) => r.kind === 'plan_ready');
    const done = rows.findIndex((r) => r.content === 'Done — saved as proposed.');
    expect(card).toBeGreaterThan(-1);
    expect(card).toBeLessThan(done);
    expect(rows.find((r) => r.content === 'yup')?.role).toBe('user');

    const [questionTurn, yesTurn] = await turns(trip.id);
    expect((yesTurn.resultMeta as { confirmedStageTurnId?: string }).confirmedStageTurnId).toBe(questionTurn.id);
  });

  it('a staged yes on a later (non-handoff) question gets no plan-ready card', async () => {
    const { trip } = await setup();
    m.penny.push(heldTurn());
    await send(trip.id, 'add Ordesa', false);
    const applied = await send(trip.id, 'sounds good');
    expect(m.replanCalls).toBe(1);
    expect(applied).toMatchObject({ appliedCount: 1, planReady: false });
  });

  it('anything but a yes discards the stage and goes to Penny', async () => {
    const { trip } = await setup();
    m.penny.push(heldTurn(), plainTurn('Bielsa it is — want me to route there instead?'));
    await send(trip.id, 'plan a national park loop from Girona', true);

    await send(trip.id, 'no, use Bielsa');
    expect(m.replanCalls).toBe(2);
    expect(await legCount(trip.id)).toBe(0);

    // ...and a yes after THAT is not a yes to the old stage.
    m.penny.push(plainTurn('Okay.'));
    await send(trip.id, 'yes');
    expect(m.replanCalls).toBe(3);
    expect(await legCount(trip.id)).toBe(0);
  });
});
