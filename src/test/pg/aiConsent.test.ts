import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Review 5.1.2(i): nothing a user wrote, photographed or was located at
 * reaches Anthropic until they agreed. Against a real Postgres:
 *
 *   - the column and its repo (null → recorded → first write wins);
 *   - the proof (`requireAiConsent` / `assertAiConsent`): minted only for a
 *     consenting user, refused when forged or someone else's;
 *   - EVERY route that sends user content to Anthropic — onboarding and
 *     replan — answers 403 `ai_consent_required` without it, writes nothing,
 *     and calls no model; with it, goes through to the model call;
 *   - `/api/me` reports it and `PATCH /api/me/preferences` records it.
 *
 * `aiConsentGuard.test.ts` (unit project) holds the list of routes to the
 * import graph, so a new Anthropic-reaching route cannot skip this.
 *
 * Auth is the only thing mocked on the route side (Auth.js is not under test
 * and cannot boot here); ownership, the consent read and every write are the
 * real repos. No `ANTHROPIC_API_KEY` is set, so even a broken gate could not
 * spend — the model calls are observed through spies instead.
 */

const m = vi.hoisted(() => ({
  userId: '',
  replanStream: vi.fn(),
  gateMessage: vi.fn(),
  scanFirstMessage: vi.fn(),
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
// The spend limits are not under test; open them.
vi.mock('@/server/payments', async (orig) => ({
  ...(await orig<typeof import('@/server/payments')>()),
  assertPennyGateOpen: vi.fn(async () => undefined),
  dailyReplanCapUsd: () => 5,
}));
vi.mock('@/server/ipLimit', () => ({ assertIpAllowed: vi.fn(async () => undefined) }));
// The three Anthropic entry points the two routes reach, observed. Each spy
// runs the REAL proof check, so a proof that is not genuine fails here too.
vi.mock('@/lib/claude', async (orig) => {
  const real = await orig<typeof import('@/lib/claude')>();
  const { assertAiConsent } = await import('@/server/aiConsent');
  m.replanStream.mockImplementation(async function* (
    _msg: string,
    _trip: string,
    _imgs: unknown,
    userId: string,
    consent: import('@/server/aiConsent').AiConsentProof,
  ) {
    assertAiConsent(consent, userId);
    yield* [] as never[];
    throw new Error('stop here: the model call was reached');
  });
  return { ...real, replanStream: m.replanStream };
});
vi.mock('@/server/messageGate', async () => {
  const { assertAiConsent } = await import('@/server/aiConsent');
  m.gateMessage.mockImplementation(async (input: { userId: string; consent: import('@/server/aiConsent').AiConsentProof }) => {
    assertAiConsent(input.consent, input.userId);
    return { tier: 'T1', by: 'allow_rule', reason: 'test', blocked: false, message: null, lockedUntil: null };
  });
  return { gateMessage: m.gateMessage };
});
vi.mock('@/server/onboardingIntentScan', async (orig) => {
  const real = await orig<typeof import('@/server/onboardingIntentScan')>();
  m.scanFirstMessage.mockImplementation(real.scanFirstMessage);
  return { ...real, scanFirstMessage: m.scanFirstMessage };
});

import { eq } from 'drizzle-orm';
import { trips, chatHistory, pennyTurns, users } from '@/server/db/schema';
import { createTrip } from '@/server/repos/trips';
import { getAiConsentAt, recordAiConsent } from '@/server/repos/users';
import { assertAiConsent, requireAiConsent, type AiConsentProof } from '@/server/aiConsent';
import { AI_CONSENT_REQUIRED_CODE } from '@/lib/aiConsent';
import { POST as onboardingPOST } from '@/app/api/trips/[id]/onboarding/route';
import { POST as replanPOST } from '@/app/api/trip/replan/route';
import { GET as meGET } from '@/app/api/me/route';
import { PATCH as preferencesPATCH } from '@/app/api/me/preferences/route';
import { jsonRequest } from '@/test/routeHarness';
import { rawQuery, resetDb, seedUser, testDb } from './harness';

const savedKey = process.env.ANTHROPIC_API_KEY;
const savedCiKey = process.env.ANTHROPIC_API_KEY_CI;

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.ANTHROPIC_API_KEY_CI;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedCiKey === undefined) delete process.env.ANTHROPIC_API_KEY_CI;
  else process.env.ANTHROPIC_API_KEY_CI = savedCiKey;
});

/** A user who owns one trip sitting at the first onboarding question. */
async function userWithTrip(): Promise<{ userId: string; tripId: string }> {
  const user = await seedUser();
  const trip = await createTrip({ userId: user.id, name: `Consent ${crypto.randomUUID().slice(0, 8)}` });
  const { db } = await testDb();
  await db.update(trips).set({ onboardingState: 'trip_intent' }).where(eq(trips.id, trip.id));
  m.userId = user.id;
  return { userId: user.id, tripId: trip.id };
}

const onboarding = (tripId: string) =>
  onboardingPOST(
    jsonRequest(`/api/trips/${tripId}/onboarding`, 'POST', {
      questionKey: 'trip_intent',
      value: 'Girona to Lisbon, leaving next Friday',
    }),
    { params: { id: tripId } },
  );

const replan = (tripId: string, handoff = false) =>
  replanPOST(
    jsonRequest('/api/trip/replan', 'POST', {
      tripId,
      message: 'Add a night in Porto',
      images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png' }],
      handoff,
    }),
  );

async function chatRows(tripId: string) {
  const { db } = await testDb();
  return db.select().from(chatHistory).where(eq(chatHistory.tripId, tripId));
}

async function turnRows(tripId: string) {
  const { db } = await testDb();
  return db.select().from(pennyTurns).where(eq(pennyTurns.tripId, tripId));
}

describe('users.ai_consent_at and its repo', () => {
  it('is a nullable timestamptz, null for a new account', async () => {
    const [col] = await rawQuery<{ data_type: string; is_nullable: string }>(
      `select data_type, is_nullable from information_schema.columns
        where table_name = 'users' and column_name = 'ai_consent_at'`,
    );
    expect(col).toEqual({ data_type: 'timestamp with time zone', is_nullable: 'YES' });
    const user = await seedUser();
    expect(await getAiConsentAt(user.id)).toBeNull();
  });

  it('records the agreement once: a second agreement keeps the first moment', async () => {
    const user = await seedUser();
    const first = new Date('2026-10-20T09:00:00Z');
    expect((await recordAiConsent(user.id, first)).toISOString()).toBe(first.toISOString());
    const again = await recordAiConsent(user.id, new Date('2026-10-21T09:00:00Z'));
    expect(again.toISOString()).toBe(first.toISOString());
    expect((await getAiConsentAt(user.id))?.toISOString()).toBe(first.toISOString());
  });

  it("only touches the agreeing account's row", async () => {
    const [a, b] = [await seedUser(), await seedUser()];
    await recordAiConsent(a.id);
    expect(await getAiConsentAt(b.id)).toBeNull();
  });

  it('refuses an account that does not exist rather than reporting success', async () => {
    await expect(recordAiConsent('no-such-user')).rejects.toThrow(/no user/);
  });
});

describe('the consent proof', () => {
  it('is refused with 403 ai_consent_required until the user agrees, then minted', async () => {
    const user = await seedUser();
    await expect(requireAiConsent(user.id)).rejects.toMatchObject({
      status: 403,
      details: { code: AI_CONSENT_REQUIRED_CODE },
    });
    await recordAiConsent(user.id);
    const proof = await requireAiConsent(user.id);
    expect(() => assertAiConsent(proof, user.id)).not.toThrow();
  });

  it('a forged proof is refused at the sink, even with the right shape', () => {
    const forged = Object.freeze({ userId: 'u1' }) as unknown as AiConsentProof;
    expect(() => assertAiConsent(forged, 'u1')).toThrow(/missing or forged/);
    expect(() => assertAiConsent(undefined as unknown as AiConsentProof, 'u1')).toThrow(/missing or forged/);
  });

  it("one user's proof does not carry another user's content", async () => {
    const [a, b] = [await seedUser(), await seedUser()];
    await recordAiConsent(a.id);
    const proof = await requireAiConsent(a.id);
    expect(() => assertAiConsent(proof, b.id)).toThrow(/another user/);
  });
});

describe('POST /api/trips/[id]/onboarding', () => {
  it('without consent: 403 ai_consent_required, nothing written, no model call', async () => {
    const { tripId } = await userWithTrip();
    const res = await onboarding(tripId);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: AI_CONSENT_REQUIRED_CODE });
    expect(m.scanFirstMessage).not.toHaveBeenCalled();
    expect(await chatRows(tripId)).toEqual([]);
    const { db } = await testDb();
    const [trip] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(trip.onboardingState).toBe('trip_intent');
  });

  it('with consent: the answer goes through to the intent scan with a genuine proof', async () => {
    const { userId, tripId } = await userWithTrip();
    await recordAiConsent(userId);
    const res = await onboarding(tripId);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(m.scanFirstMessage).toHaveBeenCalledTimes(1);
    const opts = m.scanFirstMessage.mock.calls[0][1] as { consent: AiConsentProof; userId: string };
    expect(opts.userId).toBe(userId);
    expect(() => assertAiConsent(opts.consent, userId)).not.toThrow();
    expect((await chatRows(tripId)).length).toBeGreaterThan(0);
  });
});

describe('POST /api/trip/replan', () => {
  beforeEach(() => {
    // Past the route's "no key" 503, which comes before the consent check;
    // the model call itself is the spy above and never reaches the network.
    process.env.ANTHROPIC_API_KEY = 'test-key-never-called';
  });

  for (const handoff of [false, true]) {
    it(`without consent (handoff=${handoff}): 403 ai_consent_required, no gate, no turn, no chat row`, async () => {
      const { tripId } = await userWithTrip();
      const res = await replan(tripId, handoff);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: AI_CONSENT_REQUIRED_CODE });
      expect(m.gateMessage).not.toHaveBeenCalled();
      expect(m.replanStream).not.toHaveBeenCalled();
      expect(await turnRows(tripId)).toEqual([]);
      expect(await chatRows(tripId)).toEqual([]);
    });
  }

  it('with consent: the message gate and the model call both receive a genuine proof', async () => {
    const { userId, tripId } = await userWithTrip();
    await recordAiConsent(userId);
    const res = await replan(tripId);
    expect(res.status).toBe(200);
    await res.text(); // drain the stream so the turn runs to the model call
    expect(m.gateMessage).toHaveBeenCalledTimes(1);
    expect(m.replanStream).toHaveBeenCalledTimes(1);
    const [, , , calledUser, proof] = m.replanStream.mock.calls[0] as [string, string, unknown, string, AiConsentProof];
    expect(calledUser).toBe(userId);
    expect(() => assertAiConsent(proof, userId)).not.toThrow();
  });
});

describe('/api/me and /api/me/preferences', () => {
  it('reports ai_consent false, records it on PATCH { ai_consent: true }, then reports true', async () => {
    const user = await seedUser();
    m.userId = user.id;
    expect(await (await meGET()).json()).toMatchObject({ ai_consent: false });

    const res = await preferencesPATCH(jsonRequest('/api/me/preferences', 'PATCH', { ai_consent: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ai_consent: true });

    expect(await (await meGET()).json()).toMatchObject({ ai_consent: true });
    const { db } = await testDb();
    const [row] = await db.select({ at: users.aiConsentAt }).from(users).where(eq(users.id, user.id));
    expect(row.at).toBeInstanceOf(Date);
  });

  it('refuses ai_consent: false — there is nothing to record for a decline', async () => {
    const user = await seedUser();
    m.userId = user.id;
    const res = await preferencesPATCH(jsonRequest('/api/me/preferences', 'PATCH', { ai_consent: false }));
    expect(res.status).toBe(400);
    expect(await getAiConsentAt(user.id)).toBeNull();
  });
});
