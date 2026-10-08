import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());
// Nothing in this path may reach Anthropic. If it ever imports the client and
// calls it, this mock throws and the test fails loudly.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: () => {
        throw new Error('a staged "yes" must not call the model');
      },
    };
  },
}));

import { addLeg, createTrip } from '@/server/repos/trips';
import { addStop } from '@/server/repos/stops';
import { addChatMessage, previousAssistantMessage } from '@/server/repos/chat';
import {
  createTurn,
  getLatestTripIntent,
  getPreviousTurn,
  markTurnDone,
} from '@/server/repos/pennyTurns';
import { buildStage, findLiveStage, stagedReplanResult } from '@/server/pennyStage';
import type { ValidatedAction } from '@/lib/penny/tools';
import { resetDb, seedUser } from './harness';

/**
 * A "yes" to a staged question, end to end against real Postgres: the stage is
 * found on the previous turn, it dies when anything changes, and applying it
 * re-validates the held writes without a model call. The question is the real
 * one from trip 9a3df982 (2026-10-08).
 */

beforeEach(resetDb);

const QUESTION = "For Ordesa I'd use the visitor center in Torla-Ordesa. Both good?";

async function setup() {
  const user = await seedUser();
  const trip = await createTrip({ userId: user.id, name: 'Spain loop', startDate: '2026-10-10' });
  const legId = await addLeg({
    tripId: trip.id,
    title: 'x',
    startName: 'Girona',
    endName: 'Ordesa',
    startLat: 41.98328,
    startLng: 2.82471,
    endLat: 42.64937,
    endLng: -0.0596,
    distanceKm: 433.7,
    driveTimeMinutes: 285,
  });
  const actions = [
    {
      name: 'add_stop',
      input: {
        leg_id: legId,
        data: { stop_type: 'other', name: 'Jaca', lat: 42.5704, lng: -0.5491, status: 'selected', source: 'user' },
      },
    },
  ] as unknown as ValidatedAction[];

  // The question turn: held, so its writes are staged on its row.
  const { turn: questionTurn } = await createTurn({
    tripId: trip.id,
    userId: user.id,
    idempotencyKey: crypto.randomUUID(),
    userMessage: 'plan it',
  });
  const stagedPlan = await buildStage({
    tripId: trip.id,
    actions,
    extractIntentCalled: false,
    feasibilityVerdict: null,
    question: QUESTION,
    heldQuestion: 'Both good?',
  });
  await markTurnDone(questionTurn.id, {
    resultResponse: QUESTION,
    resultMeta: { stagedPlan, tripIntent: { places: ['Picos de Europa', 'Ordesa'] } },
  });
  await addChatMessage(trip.id, 'user', 'plan it');
  await addChatMessage(trip.id, 'assistant', QUESTION);
  return { user, trip, legId, questionTurn };
}

describe('staged "yes"', () => {
  it('"yup" right after the question finds the live stage', async () => {
    const { trip, questionTurn } = await setup();
    const live = await findLiveStage({
      tripId: trip.id,
      message: 'yup',
      beforeTurnId: null,
      previousAssistant: await previousAssistantMessage(trip.id),
    });
    expect(live?.stageTurnId).toBe(questionTurn.id);
    expect(live?.kind).toBe('accept');
  });

  it('applying it re-validates the held writes into the dispatcher\'s ReplanResult — no model call', async () => {
    const { trip, user } = await setup();
    const live = await findLiveStage({
      tripId: trip.id,
      message: 'sounds good',
      beforeTurnId: null,
      previousAssistant: QUESTION,
    });
    expect(live).not.toBeNull();
    const result = await stagedReplanResult(live!, trip.id, user.id);
    expect(result.validatedActions.map((a) => a.name)).toEqual(['add_stop']);
    expect(result.failedValidations).toEqual([]);
    expect(result.toolTrace).toEqual([]);
    expect(result.response).toBe('Done — saved as proposed.');
  });

  it('"whatever you choose" applies her picks as HERS: source becomes "penny"', async () => {
    const { trip, user } = await setup();
    const live = await findLiveStage({
      tripId: trip.id,
      message: 'whatever you choose',
      beforeTurnId: null,
      previousAssistant: QUESTION,
    });
    const result = await stagedReplanResult(live!, trip.id, user.id);
    const stop = result.validatedActions[0];
    expect(stop.name === 'add_stop' && stop.input.data.source).toBe('penny');
  });

  it('anything but a yes is not a confirmation', async () => {
    const { trip } = await setup();
    for (const message of ['no, use Bielsa', 'the second one', 'yes but skip Tabernas']) {
      expect(
        await findLiveStage({ tripId: trip.id, message, beforeTurnId: null, previousAssistant: QUESTION }),
      ).toBeNull();
    }
  });

  it('dead once the trip changed underneath it', async () => {
    const { trip, legId } = await setup();
    await addStop({
      leg_id: legId,
      stop_type: 'other',
      name: 'Huesca',
      status: 'option',
      lat: 42.14,
      lng: -0.41,
      distance_from_start_km: null,
      notes: null,
      fuel_type: null,
      fuel_amount_l: null,
      source: 'user',
      source_url: null,
    });
    expect(
      await findLiveStage({ tripId: trip.id, message: 'yup', beforeTurnId: null, previousAssistant: QUESTION }),
    ).toBeNull();
  });

  it('dead once another turn came after the question', async () => {
    const { trip, user } = await setup();
    const { turn: other } = await createTurn({
      tripId: trip.id,
      userId: user.id,
      idempotencyKey: crypto.randomUUID(),
      userMessage: 'hmm what about Bielsa',
    });
    await markTurnDone(other.id, { resultResponse: 'Bielsa works too.', resultMeta: {} });
    expect(
      await findLiveStage({ tripId: trip.id, message: 'yup', beforeTurnId: null, previousAssistant: QUESTION }),
    ).toBeNull();
  });

  it('a "yes" turn that already has a row looks at the turn BEFORE it', async () => {
    const { trip, user, questionTurn } = await setup();
    const { turn: yes } = await createTurn({
      tripId: trip.id,
      userId: user.id,
      idempotencyKey: crypto.randomUUID(),
      userMessage: 'yup',
    });
    expect((await getPreviousTurn(trip.id, yes.id))?.id).toBe(questionTurn.id);
    expect(
      await findLiveStage({ tripId: trip.id, message: 'yup', beforeTurnId: yes.id, previousAssistant: QUESTION }),
    ).not.toBeNull();
  });
});

describe('getLatestTripIntent', () => {
  it("reads the latest finished turn's stored intent", async () => {
    const { trip } = await setup();
    expect(await getLatestTripIntent(trip.id)).toEqual({ places: ['Picos de Europa', 'Ordesa'] });
  });

  it('a newer turn without an extract keeps the older baseline', async () => {
    const { trip, user } = await setup();
    const { turn } = await createTurn({
      tripId: trip.id,
      userId: user.id,
      idempotencyKey: crypto.randomUUID(),
      userMessage: 'add a stop',
    });
    await markTurnDone(turn.id, { resultResponse: 'ok', resultMeta: { droppedPlaces: [] } });
    expect(await getLatestTripIntent(trip.id)).toEqual({ places: ['Picos de Europa', 'Ordesa'] });
  });

  it('is null for a trip with no extract yet', async () => {
    const user = await seedUser();
    const trip = await createTrip({ userId: user.id, name: 'Empty', startDate: '2026-10-10' });
    expect(await getLatestTripIntent(trip.id)).toBeNull();
  });
});
