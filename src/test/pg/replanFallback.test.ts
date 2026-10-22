import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Penny's dead end — "Sorry, I couldn't apply that cleanly" — is MARKED, in what
 * the replan route streams and in what it persists, so both clients can offer
 * "Try again" from structure and still offer it after a reload. And the resend
 * that button makes goes through: a word-for-word repeat straight after the
 * fallback is not refused by the message gate's exact-repeat rule.
 *
 * Through the REAL route over PGlite: the real turn record, the real chat repo,
 * the real message gate (its deterministic half — every message here is settled
 * by an allow rule, so no classifier runs). Only auth, the spend limits and the
 * model loop are stand-ins; `replanStream` yields exactly the terminal result
 * claude.ts builds for a fallback turn, so nothing here can reach Anthropic.
 */

const FALLBACK = "Sorry, I couldn't apply that cleanly — could you rephrase and try again?";
const NORMAL = 'Porto is already your second night.';

const m = vi.hoisted(() => ({
  userId: '',
  /** What the next model loop ends on: Penny's dead end, or an ordinary reply. */
  fellBack: true,
  replanStream: vi.fn(),
  reportPennyFallback: vi.fn(),
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
vi.mock('@/server/pennyFallbackAlert', () => ({ reportPennyFallback: m.reportPennyFallback }));
vi.mock('@/lib/claude', async (orig) => {
  const real = await orig<typeof import('@/lib/claude')>();
  m.replanStream.mockImplementation(async function* () {
    const response = m.fellBack ? FALLBACK : NORMAL;
    yield { kind: 'text', chunk: response };
    yield {
      kind: 'done',
      result: {
        response,
        validatedActions: [],
        retryCount: 0,
        failedValidations: [],
        truncated: false,
        leakRetryCount: 0,
        leakSanitized: false,
        fallback: m.fellBack
          ? { leakedMarkup: false, leakRetries: 0, rawChars: 0, chunks: 1, stopReason: 'end_turn' }
          : null,
        extractIntentCalled: false,
        feasibilityVerdict: null,
        fuelPlanRan: false,
        toolTrace: [[]],
        turnTrace: { prompt: 'test', calls: [] },
      },
    };
  });
  return { ...real, replanStream: m.replanStream };
});

import { asc, eq } from 'drizzle-orm';
import { chatHistory, pennyTurns } from '@/server/db/schema';
import { createTrip } from '@/server/repos/trips';
import { recordAiConsent } from '@/server/repos/users';
import { getChatPage } from '@/server/repos/chat';
import { POST } from '@/app/api/trip/replan/route';
import { POST as testTurnPOST } from '@/app/api/test/turn/route';
import { fallbackResendFor } from '@/lib/pennyFallbackRetry';
import { jsonRequest } from '@/test/routeHarness';
import { rawQuery, resetDb, seedUser, testDb } from './harness';

/** Trip vocabulary ("fuel", "stop"), so the gate's allow rule settles it for free. */
const MESSAGE = 'Add a fuel stop in Porto';
const PHOTO = { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png' };

const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The route answers 503 without a key; the model loop is mocked, so it is never used.
  process.env.ANTHROPIC_API_KEY = 'test-key-never-called';
  m.fellBack = true;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

async function userWithTrip(): Promise<string> {
  const user = await seedUser();
  await recordAiConsent(user.id);
  const trip = await createTrip({ userId: user.id, name: `Fallback ${crypto.randomUUID().slice(0, 8)}` });
  m.userId = user.id;
  return trip.id;
}

/** POST one send and read the whole SSE stream back as its frames. */
async function send(
  tripId: string,
  body: { message?: string; images?: (typeof PHOTO)[]; handoff?: boolean } = {},
): Promise<Array<Record<string, unknown>>> {
  const res = await POST(
    jsonRequest('/api/trip/replan', 'POST', {
      tripId,
      message: body.message ?? MESSAGE,
      images: body.images ?? [],
      handoff: body.handoff ?? false,
      idempotencyKey: `test-${crypto.randomUUID()}`,
    }),
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
}

const applied = (frames: Array<Record<string, unknown>>) => frames.find((f) => f.kind === 'applied');

async function chatRows(tripId: string) {
  const { db } = await testDb();
  return db.select().from(chatHistory).where(eq(chatHistory.tripId, tripId)).orderBy(asc(chatHistory.seq));
}

describe('a fallback turn is marked where both clients read it', () => {
  it('in the stream: the applied frame carries `fallback`', async () => {
    const tripId = await userWithTrip();
    const frames = await send(tripId);
    expect(applied(frames)).toMatchObject({ response: FALLBACK, fallback: { images: 0 } });
  });

  it('in the transcript: the assistant row carries fallback_meta, and the history read returns it', async () => {
    const tripId = await userWithTrip();
    await send(tripId);
    const rows = await chatRows(tripId);
    expect(rows.map((r) => [r.role, r.content, r.fallbackMeta])).toEqual([
      ['user', MESSAGE, null],
      ['assistant', FALLBACK, { images: 0 }],
    ]);
    // What a reload or relaunch actually reads.
    const { messages } = await getChatPage({ tripId });
    expect(messages.map((msg) => msg.fallback_meta)).toEqual([null, { images: 0 }]);
  });

  it('on the durable turn record, so a healed stream gets the same flag', async () => {
    const tripId = await userWithTrip();
    await send(tripId);
    const { db } = await testDb();
    const [turn] = await db.select().from(pennyTurns).where(eq(pennyTurns.tripId, tripId));
    expect(turn.status).toBe('done');
    expect((turn.resultMeta as { fallback?: unknown }).fallback).toEqual({ images: 0 });
  });

  it('counts the photos the message carried, which the transcript does not keep', async () => {
    const tripId = await userWithTrip();
    const frames = await send(tripId, { images: [PHOTO] });
    expect(applied(frames)).toMatchObject({ fallback: { images: 1 } });
    const rows = await chatRows(tripId);
    expect(rows[1].fallbackMeta).toEqual({ images: 1 });
  });

  it('still reports the fallback to the owner (PR 91 alert), beside marking it', async () => {
    const tripId = await userWithTrip();
    await send(tripId);
    expect(m.reportPennyFallback).toHaveBeenCalledTimes(1);
  });
});

describe('an ordinary reply is not marked', () => {
  it('neither in the stream nor on the row', async () => {
    const tripId = await userWithTrip();
    m.fellBack = false;
    const frames = await send(tripId);
    expect(applied(frames)).toMatchObject({ response: NORMAL, fallback: null });
    const rows = await chatRows(tripId);
    expect(rows.map((r) => r.fallbackMeta)).toEqual([null, null]);
    const [col] = await rawQuery<{ fallback_meta: unknown }>(
      `select fallback_meta from chat_history where role = 'assistant'`,
    );
    expect(col.fallback_meta).toBeNull();
  });
});

describe('"Try again" — the same message again, as a normal send', () => {
  it('is not refused as an exact repeat straight after the fallback: Penny runs again', async () => {
    const tripId = await userWithTrip();
    await send(tripId);
    m.fellBack = false;
    const frames = await send(tripId);
    expect(frames.find((f) => f.kind === 'gated'), 'refused by the gate').toBeUndefined();
    expect(applied(frames)).toMatchObject({ response: NORMAL });
    expect(m.replanStream).toHaveBeenCalledTimes(2);
    const rows = await chatRows(tripId);
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ['user', MESSAGE],
      ['assistant', FALLBACK],
      ['user', MESSAGE],
      ['assistant', NORMAL],
    ]);
  });

  it('a word-for-word repeat after an ORDINARY reply is still refused — the exemption is the flag', async () => {
    const tripId = await userWithTrip();
    m.fellBack = false;
    await send(tripId);
    const frames = await send(tripId);
    expect(frames.find((f) => f.kind === 'gated')).toMatchObject({ tier: 'T3' });
    expect(m.replanStream).toHaveBeenCalledTimes(1);
  });

  it('the hand-off turn resends as a hand-off: persisted as kind `handoff` again, not as a user bubble', async () => {
    const tripId = await userWithTrip();
    await send(tripId, { handoff: true });
    m.fellBack = false;
    const frames = await send(tripId, { handoff: true });
    expect(applied(frames)).toMatchObject({ response: NORMAL });
    const rows = await chatRows(tripId);
    expect(rows.map((r) => [r.role, r.kind, r.fallbackMeta])).toEqual([
      ['user', 'handoff', null],
      ['assistant', 'ai', { images: 0 }],
      ['user', 'handoff', null],
      ['assistant', 'ai', null],
    ]);
  });
});

/*
 * The Maestro flow (penny-try-again.yaml) opens a trip whose latest reply is a
 * fallback without asking Penny to fail: /api/test/turn's `fallback` action
 * plants the two rows. Held here to the shape the route itself writes — so the
 * app, reading the real transcript, offers the button for the right reason —
 * and to the test-endpoint guards.
 */
describe("/api/test/turn action 'fallback'", () => {
  const FIXTURE = `playwright-fb-${crypto.randomUUID().slice(0, 8)}@e2e.feraltravels.com`;
  const saved = { on: process.env.E2E_TEST_ENDPOINTS, secret: process.env.E2E_TEST_ENDPOINTS_SECRET };
  beforeEach(() => {
    process.env.E2E_TEST_ENDPOINTS = '1';
    delete process.env.E2E_TEST_ENDPOINTS_SECRET;
  });
  afterEach(() => {
    if (saved.on === undefined) delete process.env.E2E_TEST_ENDPOINTS;
    else process.env.E2E_TEST_ENDPOINTS = saved.on;
    if (saved.secret !== undefined) process.env.E2E_TEST_ENDPOINTS_SECRET = saved.secret;
  });

  const plant = (email: string, tripId: string) =>
    testTurnPOST(
      jsonRequest('/api/test/turn', 'POST', { action: 'fallback', email, tripId, message: 'SELECT name FROM trips' }),
    );

  async function fixtureTrip(email: string): Promise<string> {
    const user = await seedUser(email);
    return (await createTrip({ userId: user.id, name: `Fixture ${crypto.randomUUID().slice(0, 8)}` })).id;
  }

  it('writes the message and a flagged fallback, which the shared rule offers to resend', async () => {
    const tripId = await fixtureTrip(FIXTURE);
    const res = await plant(FIXTURE, tripId);
    expect(res.status).toBe(200);
    const { messages } = await getChatPage({ tripId });
    expect(messages.map((msg) => [msg.role, msg.kind, msg.fallback_meta])).toEqual([
      ['user', 'ai', null],
      ['assistant', 'ai', { images: 0 }],
    ]);
    expect(fallbackResendFor(messages)).toMatchObject({
      assistantId: messages[1].id,
      text: 'SELECT name FROM trips',
      images: [],
      handoff: false,
    });
  });

  it('is a 404 with the test endpoints off, and writes nothing', async () => {
    const tripId = await fixtureTrip(FIXTURE);
    delete process.env.E2E_TEST_ENDPOINTS;
    expect((await plant(FIXTURE, tripId)).status).toBe(404);
    expect(await chatRows(tripId)).toEqual([]);
  });

  it('refuses a non-fixture address, and a trip the fixture does not own', async () => {
    const realTrip = await fixtureTrip(`someone-${crypto.randomUUID().slice(0, 8)}@pg.test`);
    expect((await plant(`someone-else@pg.test`, realTrip)).status).toBe(400);
    await seedUser(FIXTURE);
    expect((await plant(FIXTURE, realTrip)).status).toBe(400);
    expect(await chatRows(realTrip)).toEqual([]);
  });
});
