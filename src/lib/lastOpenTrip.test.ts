/**
 * Where a bottom-nav tab goes when there is no trip in scope.
 *
 * The bug: LIST / MAP / CHAT all navigated to `/trips`, the index. So tapping
 * CHAT from Settings, with Penny mid-answer, put the driver on a list of trips
 * rather than back in the conversation they had just left (reproduced on a
 * simulator, 2026-09-11). They are tabs OF a trip; a list of trips is not an
 * answer to any of them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  forgetLastOpenTrip,
  lastOpenTripId,
  rememberLastOpenTrip,
  subscribeLastOpenTrip,
  tripTabDestination,
} from './lastOpenTrip';

beforeEach(() => forgetLastOpenTrip());

describe('tripTabDestination', () => {
  it('returns to the remembered trip, on the tab that was tapped', () => {
    expect(tripTabDestination('chat', 't1')).toBe('/trips/t1?tab=chat');
    expect(tripTabDestination('list', 't1')).toBe('/trips/t1?tab=list');
    expect(tripTabDestination('map', 't1')).toBe('/trips/t1?tab=map');
  });

  /**
   * Spelled out because it is the requirement most likely to be lost when
   * someone simplifies this: a driver who has never opened a trip has no chat
   * to be returned to, and must still reach the index.
   */
  it('falls back to the trips index when no trip has ever been opened', () => {
    expect(tripTabDestination('chat', null)).toBe('/trips');
    expect(tripTabDestination('list', null)).toBe('/trips');
  });

  it('treats an empty id as no trip rather than building /trips/', () => {
    expect(tripTabDestination('chat', '')).toBe('/trips');
  });
});

describe('the remembered trip', () => {
  it('starts empty and records the last one opened', () => {
    expect(lastOpenTripId()).toBeNull();
    rememberLastOpenTrip('t1');
    expect(lastOpenTripId()).toBe('t1');
    rememberLastOpenTrip('t2');
    expect(lastOpenTripId()).toBe('t2');
  });

  it('is cleared by forgetLastOpenTrip — this is what sign-out calls', () => {
    rememberLastOpenTrip('t1');
    forgetLastOpenTrip();
    expect(lastOpenTripId()).toBeNull();
  });

  it('notifies subscribers on a change and not on a repeat', () => {
    let calls = 0;
    const off = subscribeLastOpenTrip(() => (calls += 1));
    rememberLastOpenTrip('t1');
    expect(calls).toBe(1);
    rememberLastOpenTrip('t1');
    expect(calls).toBe(1);
    off();
    rememberLastOpenTrip('t2');
    expect(calls).toBe(1);
  });
});
