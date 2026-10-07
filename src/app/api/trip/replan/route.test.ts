import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The idempotent replay on POST /api/trip/replan answers only the account
 * that made the turn. Until 2026-10-07 the route looked the turn up by key
 * alone (`getTurnByKey`), so another account sending a used key got the
 * owner's message and Penny's reply back. e2e/money-limits.spec.ts holds the
 * same contract against a deployed preview; this holds it on every unit run.
 *
 * The REAL repo (`getTurnByKeyForUser`, `createTurn`) runs over a fake
 * database holding ONE planted turn: every key lookup returns it and every
 * insert conflicts, which is exactly the table's behaviour for the one key
 * both requests here send. Everything before the turn record (auth, caps,
 * breaker, per-IP limit) is mocked open; `handoff: true` skips the gate, as in
 * the e2e spec, so nothing here can reach Anthropic.
 */

const OWNER = 'user-owner';
const OTHER = 'user-other';
const OWNER_TRIP = '00000000-0000-4000-8000-0000000000b1';
const OTHER_TRIP = '00000000-0000-4000-8000-0000000000b2';
const KEY = 'owner-send-key-0001';
const OWNER_MESSAGE = 'Plan my trip to the owner secret place';
const PENNY_REPLY = 'Here is the plan for the owner secret place';

const m = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  insert: vi.fn(),
  requireEntitledUser: vi.fn(),
  addChatMessage: vi.fn(),
  logUsageEvent: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/auth/index', () => ({ auth: vi.fn() }));
vi.mock('@/server/db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => m.rows }) }) }),
    insert: (...a: unknown[]) => {
      m.insert(...a);
      return { values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) };
    },
  },
}));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireEntitledUser: m.requireEntitledUser,
  assertTripOwnedByUser: vi.fn(async () => undefined),
}));
vi.mock('@/server/payments', () => ({
  assertPennyGateOpen: vi.fn(async () => undefined),
  dailyReplanCapUsd: () => 5,
  REPLAN_USD_CAP_PER_DAY: 5,
}));
vi.mock('@/server/ipLimit', () => ({ assertIpAllowed: vi.fn(async () => undefined) }));
vi.mock('@/server/repos/usage', () => ({
  getUserUsageSummary: vi.fn(async () => ({ requests: 0, microcents: 0 })),
  microcentsToDollars: () => 0,
  logUsageEvent: m.logUsageEvent,
}));
vi.mock('@/server/repos/chat', () => ({ addChatMessage: m.addChatMessage }));
vi.mock('@/server/messageGate', () => ({ gateMessage: vi.fn() }));

import { POST } from './route';
import { jsonRequest } from '@/test/routeHarness';

const send = (tripId: string) =>
  POST(jsonRequest('/api/trip/replan', 'POST', { tripId, message: 'Plan my trip', handoff: true, idempotencyKey: KEY }));

const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.ANTHROPIC_API_KEY = 'test-key-never-called';
  m.logUsageEvent.mockResolvedValue(undefined);
  const at = new Date('2026-10-07T09:00:00Z');
  m.rows = [{
    id: '00000000-0000-4000-8000-00000000aaaa',
    tripId: OWNER_TRIP,
    userId: OWNER,
    idempotencyKey: KEY,
    status: 'done',
    userMessage: OWNER_MESSAGE,
    images: null,
    resultResponse: PENNY_REPLY,
    resultMeta: null,
    errorMessage: null,
    createdAt: at,
    updatedAt: at,
  }];
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

const as = (id: string) => m.requireEntitledUser.mockResolvedValue({ id, isAdmin: false, verdict: { state: 'active' } });

describe("POST /api/trip/replan — a used idempotency key replays only to its owner", () => {
  it('the owner sending their own key gets their turn back, and nothing runs again', async () => {
    as(OWNER);
    const res = await send(OWNER_TRIP);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { turn: { idempotency_key: string; result_response: string } };
    expect(body.turn).toMatchObject({ idempotency_key: KEY, result_response: PENNY_REPLY });
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.addChatMessage).not.toHaveBeenCalled();
  });

  it("another account sending the owner's key gets 409 and nothing of the owner's turn", async () => {
    as(OTHER);
    const res = await send(OTHER_TRIP);
    const text = await res.text();
    expect(res.status, text).toBe(409);
    expect(text).toMatch(/already in use/);
    for (const secret of [OWNER, OWNER_TRIP, OWNER_MESSAGE, PENNY_REPLY]) expect(text).not.toContain(secret);
    // Nothing written for the caller either: no turn, no chat bubble.
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.addChatMessage).not.toHaveBeenCalled();
  });

  it('the same account on a different trip is refused too (the key belongs to one trip)', async () => {
    as(OWNER);
    const res = await send(OTHER_TRIP);
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain(PENNY_REPLY);
  });
});
