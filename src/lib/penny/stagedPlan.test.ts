import { describe, expect, it } from 'vitest';
import {
  judgeStage,
  MAX_STAGE_AGE_MS,
  stagedPlanSchema,
  tripFingerprint,
  type FingerprintTrip,
  type StagedPlan,
} from './stagedPlan';

/**
 * A staged "yes": applied only when it is still the live question on an
 * unchanged trip. The question is the real one from trip 9a3df982.
 */

const QUESTION =
  "Two quick clarifications: for Ordesa I'd go with the visitor center in Torla-Ordesa, and for Tabernas the town itself. Both good?";

function trip(over: Partial<FingerprintTrip> = {}): FingerprintTrip {
  return {
    start_date_parsed: '2026-10-10',
    current_leg_id: null,
    daily_drive_hours: 6,
    vehicle_id: 'v1',
    legs: [
      {
        id: 'leg-1',
        sort_order: 0,
        leg_type: 'drive',
        start_name: 'Girona',
        end_name: 'Ordesa',
        start_lat: 41.98,
        start_lng: 2.82,
        end_lat: 42.65,
        end_lng: -0.06,
        distance_km: 433.7,
        drive_time_minutes: 285,
        stops: [{ id: 's1', stop_type: 'other', status: 'selected', name: 'Jaca', lat: 42.57, lng: -0.55 }],
        routes: [],
        tasks: [],
      },
    ],
    ...over,
  };
}

/** The trip with its one leg changed. */
function withLeg(over: Partial<FingerprintTrip['legs'][number]>): FingerprintTrip {
  const base = trip();
  return { ...base, legs: [{ ...base.legs[0], ...over }] };
}

const NOW = new Date('2026-10-08T11:00:00Z');

function stage(over: Partial<StagedPlan> = {}): StagedPlan {
  return {
    version: 1,
    actions: [{ name: 'add_stop', input: { leg_id: 'leg-1', data: { stop_type: 'other', name: 'Torla' } } }],
    fingerprint: tripFingerprint(trip()),
    extractIntentCalled: false,
    feasibilityVerdict: null,
    question: QUESTION,
    heldQuestion: 'Both good?',
    stagedAt: '2026-10-08T10:48:19Z',
    ...over,
  };
}

const judge = (s: StagedPlan | null, over: Partial<Parameters<typeof judgeStage>[0]> = {}) =>
  judgeStage({
    stage: s,
    isPreviousTurn: true,
    previousAssistant: QUESTION,
    currentFingerprint: tripFingerprint(trip()),
    now: NOW,
    ...over,
  });

describe('judgeStage', () => {
  it('the live case: "yup" straight after the question, nothing changed', () => {
    expect(judge(stage())).toEqual({ live: true });
  });

  it('no stage, no apply', () => {
    expect(judge(null)).toEqual({ live: false, reason: 'no_stage' });
  });

  it('dead once any other turn came between', () => {
    expect(judge(stage(), { isPreviousTurn: false })).toEqual({ live: false, reason: 'not_previous_turn' });
  });

  it('dead when the reply answers a different message (e.g. a gate line came between)', () => {
    expect(judge(stage(), { previousAssistant: "I can't check that, but I can plan around it." })).toEqual({
      live: false,
      reason: 'answers_other_message',
    });
  });

  it('dead after 48 hours', () => {
    const old = new Date(NOW.getTime() - MAX_STAGE_AGE_MS - 1000).toISOString();
    expect(judge(stage({ stagedAt: old }))).toEqual({ live: false, reason: 'expired' });
  });

  it('dead when the trip changed underneath it', () => {
    const moved = withLeg({ end_name: 'Bielsa', end_lat: 42.63 });
    expect(judge(stage(), { currentFingerprint: tripFingerprint(moved) })).toEqual({
      live: false,
      reason: 'trip_changed',
    });
  });
});

describe('tripFingerprint', () => {
  it('is stable for the same trip', () => {
    expect(tripFingerprint(trip())).toBe(tripFingerprint(trip()));
  });

  it('moves when a leg, a non-fuel stop, the start date or the order changes', () => {
    const base = tripFingerprint(trip());
    expect(tripFingerprint(trip({ start_date_parsed: '2026-10-11' }))).not.toBe(base);
    const first = trip().legs[0];
    expect(tripFingerprint(withLeg({ stops: [{ ...first.stops[0], status: 'dismissed' }] }))).not.toBe(base);
    expect(tripFingerprint(withLeg({ sort_order: 3 }))).not.toBe(base);
  });

  it('ignores fuel stops: Finn writes them when a day is merely opened', () => {
    const first = trip().legs[0];
    const t = withLeg({
      stops: [...first.stops, { id: 'f1', stop_type: 'fuel', status: 'option', name: 'Repsol', lat: 42, lng: 0 }],
    });
    expect(tripFingerprint(t)).toBe(tripFingerprint(trip()));
  });
});

describe('stagedPlanSchema', () => {
  it('round-trips a stage through JSON (as jsonb stores it)', () => {
    const parsed = stagedPlanSchema.safeParse(JSON.parse(JSON.stringify(stage())));
    expect(parsed.success).toBe(true);
  });

  it('refuses an empty or malformed stage', () => {
    expect(stagedPlanSchema.safeParse(stage({ actions: [] })).success).toBe(false);
    expect(stagedPlanSchema.safeParse({ ...stage(), fingerprint: 'short' }).success).toBe(false);
    expect(stagedPlanSchema.safeParse(null).success).toBe(false);
  });
});
