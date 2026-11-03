import { describe, expect, it } from 'vitest';
import { parseSse, judgeTurn, judgePlan, judgeFuel, judgeTokenExpiry } from '../../scripts/prod-canary.mjs';

/**
 * The verdicts `scripts/prod-canary.mjs` hands down on production. The canary
 * exists because a green suite said nothing about production's Anthropic key
 * (docs/design/prod-canary.md); a canary whose judge passes a broken turn is
 * the same silence one level up, so each way a turn can LOOK fine and not be
 * is pinned here.
 *
 * HEALTHY is the hand-off turn as production streamed it on 2026-11-03
 * (Girona → Barcelona), trimmed to the fields the judge reads.
 */
const HEALTHY = [
  'data: {"kind":"received"}',
  'data: {"kind":"reading"}',
  'data: {"kind":"iteration_start","index":0}',
  'data: {"kind":"text","chunk":"Done — Girona to Barcelona on Dec 3."}',
  'data: {"kind":"applied","response":"Done — Girona to Barcelona on Dec 3.","appliedCount":1,"failedCount":0,"failedActions":[],"persistFailedCount":0,"persistFailedActions":[],"validationFailures":[],"fallback":null,"toolTrace":[["resolve_place","resolve_place"],["get_route"],["add_leg"],[]],"modelCalls":4}',
].join('\n\n') + '\n\n';

const DONE = { status: 'done', error_message: null };
const withApplied = (patch: Record<string, unknown>) =>
  parseSse(HEALTHY).map((e: { kind: string }) => (e.kind === 'applied' ? { ...e, ...patch } : e));

describe('judgeTurn', () => {
  it('passes the turn production actually streamed', () => {
    expect(judgeTurn(parseSse(HEALTHY), DONE, { minApplied: 1 })).toEqual([]);
  });

  it('fails an error event — the shape an expired Anthropic key produces (runTurnWork → send kind error)', () => {
    const events = [...parseSse(HEALTHY).filter((e: { kind: string }) => e.kind !== 'applied'), { kind: 'error', message: '401 invalid x-api-key' }];
    const problems = judgeTurn(events, { status: 'error', error_message: '401 invalid x-api-key' });
    expect(problems.join(' ')).toMatch(/stream error: 401 invalid x-api-key/);
    expect(problems.join(' ')).toMatch(/expected exactly one applied/);
    expect(problems.join(' ')).toMatch(/penny_turns status 'error'/);
  });

  it('fails a fallback bubble even though it arrives as a normal applied event', () => {
    expect(judgeTurn(withApplied({ fallback: { reason: 'no_tool_call' } }), DONE).join(' ')).toMatch(/fallback/);
  });

  it('fails a hand-off that applied nothing', () => {
    expect(judgeTurn(withApplied({ appliedCount: 0 }), DONE, { minApplied: 1 }).join(' ')).toMatch(/appliedCount 0/);
  });

  it('fails failed, unpersisted or invalid actions', () => {
    expect(judgeTurn(withApplied({ failedCount: 1, failedActions: [{ action: 'add_leg' }] }), DONE)).not.toEqual([]);
    expect(judgeTurn(withApplied({ persistFailedCount: 1 }), DONE)).not.toEqual([]);
    expect(judgeTurn(withApplied({ validationFailures: [{ x: 1 }] }), DONE)).not.toEqual([]);
  });

  it('fails when the required tool was never called', () => {
    expect(judgeTurn(parseSse(HEALTHY), DONE, { requireTool: 'plan_fuel_stops' }).join(' ')).toMatch(/did not call plan_fuel_stops/);
    expect(judgeTurn(withApplied({ toolTrace: [['declare_fuel_state', 'plan_fuel_stops'], []] }), DONE, { requireTool: 'plan_fuel_stops' })).toEqual([]);
  });

  it('fails a turn whose durable row is missing or not done', () => {
    expect(judgeTurn(parseSse(HEALTHY), null)).not.toEqual([]);
    expect(judgeTurn(parseSse(HEALTHY), { status: 'running' })).not.toEqual([]);
  });

  it('fails a stream frame that is not JSON', () => {
    expect(judgeTurn(parseSse(HEALTHY + 'data: <html>502</html>\n\n'), DONE)).not.toEqual([]);
  });
});

const LEG = { start_name: 'Girona, Spain', end_name: 'Barcelona, Spain', start_lat: 41.98, start_lng: 2.82, end_lat: 41.38, end_lng: 2.16, fuel_status: 'ready', stops: [] as unknown[] };

describe('judgePlan', () => {
  it('passes Girona → Barcelona with coordinates', () => expect(judgePlan({ legs: [LEG] })).toEqual([]));
  it('fails no legs, the wrong ends, or a missing coordinate', () => {
    expect(judgePlan({ legs: [] })).not.toEqual([]);
    expect(judgePlan({ legs: [{ ...LEG, end_name: 'Lyon' }] })).not.toEqual([]);
    expect(judgePlan({ legs: [{ ...LEG, end_lat: null }] })).not.toEqual([]);
  });
});

describe('judgeFuel', () => {
  const station = { stop_type: 'fuel', source: 'google', place_id: 'ChIJ-x8sP1MiuxIRjksE6aMpOew', name: 'Fuel stop' };
  it('passes a Google station with a place_id', () => expect(judgeFuel({ legs: [{ ...LEG, stops: [station] }] })).toEqual([]));
  it('fails no fuel stop — what a dead Places key leaves behind', () => {
    expect(judgeFuel({ legs: [LEG] })).not.toEqual([]);
    expect(judgeFuel({ legs: [{ ...LEG, fuel_status: 'failed', stops: [station] }] })).not.toEqual([]);
  });
  it('fails a fuel stop that did not come from Google', () => {
    expect(judgeFuel({ legs: [{ ...LEG, stops: [{ ...station, source: 'user', place_id: null }] }] })).not.toEqual([]);
  });
});

describe('judgeTokenExpiry', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  it('is quiet with more than five days left', () => expect(judgeTokenExpiry('2026-12-03T12:52:03Z', now)).toBeNull());
  it('warns inside five days, and when the expiry is unknown or garbage', () => {
    expect(judgeTokenExpiry('2026-11-07T12:00:00Z', now)).toMatch(/prod-canary-token\.sh/);
    expect(judgeTokenExpiry(undefined, now)).toMatch(/not set/);
    expect(judgeTokenExpiry('soon', now)).toMatch(/not a date/);
  });
});
