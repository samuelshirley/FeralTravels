import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());

import { eq } from 'drizzle-orm';
import { accounts, announcementDismissals, usageEvents, users } from '@/server/db/schema';
import { createTrip } from '@/server/repos/trips';
import {
  addVehicle,
  deleteVehicle,
  getDefaultVehicleForUser,
  listVehiclesForUser,
  setDefaultVehicle,
  updateVehicle,
} from '@/server/repos/vehicles';
import {
  getStrikeState,
  getUnitsPref,
  getUserIdentity,
  getUserTimezone,
  setStrikeState,
  setUnitsPref,
  setUserTimezone,
} from '@/server/repos/users';
import { addChatMessage, getChatHistory, getChatPage } from '@/server/repos/chat';
import {
  createAnnouncement,
  dismissAnnouncement,
  getActiveAnnouncementForUser,
  listAnnouncements,
} from '@/server/repos/announcements';
import {
  claimNextQueuedTurn,
  createTurn,
  getTurnByKey,
  markTurnDone,
  promoteTurnToRunning,
} from '@/server/repos/pennyTurns';
import { getUserUsageSummary, logAnthropicUsage, logUsageEvent } from '@/server/repos/usage';
import {
  effectiveJevMode,
  getUserJevOverride,
  logJevUsage,
  setGlobalJevMode,
  setUserJevOverride,
} from '@/server/repos/jev';
import { listDeletedAccounts, wasEmailDeleted } from '@/server/repos/accountDeletion';
import { deleteAccount } from '@/server/deleteAccount';
import type { ChatFormMeta, PlanSummary } from '@/types/trip';
import { pgError, rawQuery, resetDb, seedUser, testDb } from './harness';

/**
 * The per-account tables, through their real repos against a real Postgres.
 */

beforeEach(resetDb);

describe('users', () => {
  it('units, timezone, identity and the Penny strike lock round-trip', async () => {
    const user = await seedUser('Driver@PG.test');
    expect(await getUnitsPref(user.id)).toBe('metric');
    await setUnitsPref(user.id, 'imperial');
    expect(await getUnitsPref(user.id)).toBe('imperial');
    expect(await setUserTimezone(user.id, ' Europe/Madrid ')).toBe('Europe/Madrid');
    expect(await getUserTimezone(user.id)).toBe('Europe/Madrid');
    expect(await getUserIdentity(user.id)).toMatchObject({
      id: user.id,
      email: 'Driver@PG.test',
      name: 'PG Test',
    });
    const lockedUntil = new Date('2026-03-01T18:45:00-08:00');
    await setStrikeState(user.id, { strikes: 3, lockedUntil });
    const strikes = await getStrikeState(user.id);
    expect(strikes.strikes).toBe(3);
    expect(strikes.lockedUntil?.toISOString()).toBe('2026-03-02T02:45:00.000Z');
  });

  it('email is unique', async () => {
    const { db } = await testDb();
    await seedUser('same@pg.test');
    const err = await pgError(db.insert(users).values({ email: 'same@pg.test' }));
    expect(err.code).toBe('23505');
  });

  it("accounts' (provider, providerAccountId) primary key refuses a second link", async () => {
    const { db } = await testDb();
    const a = await seedUser();
    const b = await seedUser();
    const row = { type: 'oauth' as const, provider: 'google', providerAccountId: 'sub-1' };
    await db.insert(accounts).values({ ...row, userId: a.id });
    const err = await pgError(db.insert(accounts).values({ ...row, userId: b.id }));
    expect(err.code).toBe('23505');
  });
});

describe('vehicles', () => {
  it('the first vehicle is the default; switching moves the flag; the default cannot be deleted', async () => {
    const user = await seedUser();
    const van = await addVehicle(user.id, { name: 'Van', range_km: 640, fuel_type: 'diesel' });
    expect(van).toMatchObject({ is_default: true, range_km: 640, fuel_type: 'diesel' });
    const bike = await addVehicle(user.id, { name: 'Bike', range_km: 280, fuel_type: 'petrol' });
    expect(bike.is_default).toBe(false);
    await setDefaultVehicle(user.id, bike.id);
    expect((await getDefaultVehicleForUser(user.id))?.id).toBe(bike.id);
    const updated = await updateVehicle(user.id, van.id, { range_km: 700, fuel_type: null });
    expect(updated).toMatchObject({ is_default: false, range_km: 700, fuel_type: null });
    expect(await deleteVehicle(user.id, bike.id)).toMatchObject({ ok: false, reason: 'default_vehicle' });
    expect(await deleteVehicle(user.id, van.id)).toEqual({ ok: true });
    expect((await listVehiclesForUser(user.id)).map((v) => v.name)).toEqual(['Bike']);
  });

  it("another user's vehicle reads as not found", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const van = await addVehicle(owner.id, { name: 'Van' });
    expect(await updateVehicle(other.id, van.id, { name: 'Mine now' })).toBeNull();
    expect(await deleteVehicle(other.id, van.id)).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('deleting a vehicle a trip uses sets the trip vehicle to null, not the trip gone', async () => {
    const user = await seedUser();
    await addVehicle(user.id, { name: 'Keep' });
    const spare = await addVehicle(user.id, { name: 'Spare' });
    const trip = await createTrip({ userId: user.id, name: 'With spare', vehicleId: spare.id });
    expect(await deleteVehicle(user.id, spare.id)).toEqual({ ok: true });
    const [row] = await rawQuery<{ vehicle_id: string | null }>(
      `select vehicle_id from trips where id = $1`,
      [trip.id],
    );
    expect(row.vehicle_id).toBeNull();
  });
});

describe('chat_history', () => {
  it('plan_summary and form_meta jsonb come back exactly, and seq pages in order', async () => {
    const user = await seedUser();
    const trip = await createTrip({ userId: user.id, name: 'Chatty' });
    const planSummary: PlanSummary = {
      total_days: 4,
      drive_days: 3,
      rest_days: 1,
      depart_date_iso: '2026-03-01',
      depart_name: 'Madrid',
      arrive_date_iso: '2026-03-04',
      arrive_name: 'Lisbon',
      depart_time: '08:00',
      arrive_time: '17:40',
      total_distance_km: 1203.5,
      total_drive_minutes: 812,
      nights_per_stop: [
        { name: 'Mérida', nights: 2 },
        { name: null, nights: 1 },
      ],
    };
    const formMeta: ChatFormMeta = {
      question: 'How far do you drive a day?',
      kind: 'chips',
      options: [
        { value: '4', label: '4 hours' },
        { value: '6', label: '6 hours' },
      ],
      selected: '6',
      answerLabel: '6 hours',
    };
    await addChatMessage(trip.id, 'assistant', 'How far?', null, 'form_question');
    await addChatMessage(trip.id, 'user', '6 hours', null, 'form_answer', null, formMeta);
    await addChatMessage(trip.id, 'assistant', 'Plan ready', 'added 4 legs', 'plan_ready', planSummary, null, {
      tier: 'T2',
      by: 'haiku',
    });
    const history = await getChatHistory(trip.id);
    expect(history.map((m) => m.kind)).toEqual(['form_question', 'form_answer', 'plan_ready']);
    expect(history[1].form_meta).toEqual(formMeta);
    expect(history[2].plan_summary).toEqual(planSummary);
    expect(history[2].changes_made).toBe('added 4 legs');
    const [gate] = await rawQuery<{ gate_tier: string; gate_by: string }>(
      `select gate_tier, gate_by from chat_history where kind = 'plan_ready'`,
    );
    expect(gate).toEqual({ gate_tier: 'T2', gate_by: 'haiku' });

    const lastTwo = await getChatPage({ tripId: trip.id, limit: 2 });
    expect(lastTwo.hasMore).toBe(true);
    expect(lastTwo.messages.map((m) => m.content)).toEqual(['6 hours', 'Plan ready']);
    const first = await getChatPage({ tripId: trip.id, beforeSeq: lastTwo.messages[0].seq });
    expect(first.messages.map((m) => m.content)).toEqual(['How far?']);
  });
});

describe('announcements and dismissals', () => {
  it('an announcement shows until dismissed, and dismissing twice is one row', async () => {
    const a = await seedUser();
    const b = await seedUser();
    const ann = await createAnnouncement({ title: 'New', body: 'Fuel prices are live' });
    expect(ann.buttonText).toBe('Got it');
    expect((await getActiveAnnouncementForUser(a.id))?.id).toBe(ann.id);
    await dismissAnnouncement(a.id, ann.id);
    await dismissAnnouncement(a.id, ann.id);
    expect(await getActiveAnnouncementForUser(a.id)).toBeNull();
    expect((await getActiveAnnouncementForUser(b.id))?.id).toBe(ann.id);
    expect((await listAnnouncements())[0]).toMatchObject({ id: ann.id, dismissCount: 1 });
  });

  it('deleting the user or the announcement takes the dismissal', async () => {
    const { db } = await testDb();
    const user = await seedUser();
    const ann = await createAnnouncement({ title: 'T', body: 'B' });
    await dismissAnnouncement(user.id, ann.id);
    await db.delete(users).where(eq(users.id, user.id));
    expect(await db.select().from(announcementDismissals)).toEqual([]);
  });
});

describe('penny_turns', () => {
  it('images and result_meta jsonb round-trip, and the key is idempotent', async () => {
    const user = await seedUser();
    const trip = await createTrip({ userId: user.id, name: 'Turns' });
    const images = [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png' }];
    const { turn, created } = await createTurn({
      tripId: trip.id,
      userId: user.id,
      idempotencyKey: 'send-1',
      userMessage: 'Plan Madrid to Lisbon',
      images,
    });
    expect(created).toBe(true);
    expect(turn.status).toBe('queued');
    expect(turn.images).toEqual(images);
    const again = await createTurn({
      tripId: trip.id,
      userId: user.id,
      idempotencyKey: 'send-1',
      userMessage: 'Plan Madrid to Lisbon',
    });
    expect(again).toMatchObject({ created: false, turn: { id: turn.id } });
    const resultMeta = { legsAdded: 4, tools: ['add_leg', 'plan_fuel_stops'], gate: { tier: 'T3' } };
    await promoteTurnToRunning(turn.id);
    await markTurnDone(turn.id, { resultResponse: 'Done', resultMeta });
    expect(await getTurnByKey('send-1')).toMatchObject({ status: 'done', result_meta: resultMeta });
  });

  it('the partial unique index lets only one turn per trip run', async () => {
    const user = await seedUser();
    const trip = await createTrip({ userId: user.id, name: 'Race' });
    const make = (k: string) =>
      createTurn({ tripId: trip.id, userId: user.id, idempotencyKey: k, userMessage: k });
    const first = (await make('a')).turn;
    const second = (await make('b')).turn;
    expect((await promoteTurnToRunning(first.id))?.status).toBe('running');
    // Postgres refuses the second running row; the repo maps that to null.
    expect(await promoteTurnToRunning(second.id)).toBeNull();
    expect(await claimNextQueuedTurn(trip.id)).toBeNull();
    await markTurnDone(first.id, { resultResponse: 'ok' });
    expect((await claimNextQueuedTurn(trip.id))?.id).toBe(second.id);
  });

  it('the idempotency key is unique across users', async () => {
    const a = await seedUser();
    const b = await seedUser();
    const tripA = await createTrip({ userId: a.id, name: 'A' });
    const tripB = await createTrip({ userId: b.id, name: 'B' });
    await createTurn({ tripId: tripA.id, userId: a.id, idempotencyKey: 'k', userMessage: 'x' });
    await expect(
      createTurn({ tripId: tripB.id, userId: b.id, idempotencyKey: 'k', userMessage: 'y' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('usage_events', () => {
  it('cost_microcents is a bigint that survives past 2^31, and the summary sums it', async () => {
    const { db } = await testDb();
    const user = await seedUser();
    // 120M input tokens of Haiku is well over 2^31 microcents.
    await logAnthropicUsage({
      userId: user.id,
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 120_000_000,
      outputTokens: 1_000,
    });
    await logUsageEvent({ userId: user.id, provider: 'google:directions', requests: 2 });
    const rows = await db.select().from(usageEvents).where(eq(usageEvents.provider, 'anthropic'));
    expect(rows[0].costMicrocents).toBeGreaterThan(2 ** 31);
    expect(Number.isSafeInteger(rows[0].costMicrocents)).toBe(true);
    const [stored] = await rawQuery<{ c: string }>(
      `select cost_microcents::text as c from usage_events where provider = 'anthropic'`,
    );
    expect(Number(stored.c)).toBe(rows[0].costMicrocents);
    const summary = await getUserUsageSummary(user.id, 1);
    expect(Number(summary.microcents)).toBe(rows[0].costMicrocents);
    expect(Number(summary.requests)).toBe(3);
  });

  it("the Jev meta jsonb round-trips, and Jev's override and global mode persist", async () => {
    const { db } = await testDb();
    const user = await seedUser();
    await setGlobalJevMode('compare');
    expect(await setUserJevOverride(user.id, 'on')).toBe(true);
    expect(await getUserJevOverride(user.id)).toBe('on');
    expect(await effectiveJevMode(user.id)).toEqual({ mode: 'on', source: 'user' });
    const outcome: Parameters<typeof logJevUsage>[0]['outcome'] = {
      settled: true,
      choice: 'T1',
      top: 0.92,
      margin: 0.4,
      latencyMs: 210,
      deferredReason: null,
      echoedModel: 'jev-1',
      inputTokens: 40,
      outputTokens: 3,
      success: true,
      errorMessage: null,
    };
    await logJevUsage({ userId: user.id, tripId: null, source: 'user', outcome, model: 'jev-1' });
    const [row] = await db.select().from(usageEvents).where(eq(usageEvents.provider, 'jev'));
    expect(row.meta).toMatchObject({ mode: 'user', choice: 'T1', top: 0.92, margin: 0.4 });
    const [typed] = await rawQuery<{ t: string }>(`select jsonb_typeof(meta) as t from usage_events`);
    expect(typed.t).toBe('object');
  });

  it('a deleted trip or user leaves its usage rows, unlinked', async () => {
    const { db } = await testDb();
    const user = await seedUser();
    const trip = await createTrip({ userId: user.id, name: 'Spend' });
    await logUsageEvent({ userId: user.id, tripId: trip.id, provider: 'anthropic' });
    await db.delete(users).where(eq(users.id, user.id));
    const rows = await db.select().from(usageEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: null, tripId: null, provider: 'anthropic' });
  });
});

describe('account deletion', () => {
  const KEY = 'a'.repeat(64);

  it('deleteAccount tombstones the account and cascades everything it owned', async () => {
    vi.stubEnv('DELETED_USER_ENC_KEY', KEY);
    try {
      const user = await seedUser('Leaving@PG.test');
      const trip = await createTrip({ userId: user.id, name: 'Last trip' });
      await addVehicle(user.id, { name: 'Van' });
      await addChatMessage(trip.id, 'user', 'bye');
      await createTurn({ tripId: trip.id, userId: user.id, idempotencyKey: 'bye', userMessage: 'bye' });
      await logUsageEvent({ userId: user.id, provider: 'anthropic', errorMessage: 'user text' });

      const summary = await deleteAccount(user.id, 'self', {
        revoke: async () => {
          throw new Error('no Apple account: revoke must not be called');
        },
      });
      expect(summary).toEqual({
        tripCount: 1,
        vehicleCount: 1,
        chatMessageCount: 1,
        signInProviders: ['otp'],
      });

      const left = await rawQuery<Record<string, number>>(
        `select
           (select count(*)::int from users) as users,
           (select count(*)::int from trips) as trips,
           (select count(*)::int from vehicles) as vehicles,
           (select count(*)::int from chat_history) as chat,
           (select count(*)::int from penny_turns) as turns,
           (select count(*)::int from usage_events where error_message is not null) as usage_text`,
      );
      expect(left[0]).toEqual({ users: 0, trips: 0, vehicles: 0, chat: 0, turns: 0, usage_text: 0 });

      const [tomb] = await listDeletedAccounts();
      expect(tomb).toMatchObject({
        email: 'leaving@pg.test',
        signInProviders: ['otp'],
        tripCount: 1,
        vehicleCount: 1,
        chatMessageCount: 1,
        deletedBy: 'self',
      });
      expect(tomb.accountCreatedAt?.toISOString()).toBe(user.createdAt.toISOString());
      expect(typeof tomb.id).toBe('number'); // bigserial in number mode
      expect(await wasEmailDeleted(' LEAVING@pg.test ')).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
