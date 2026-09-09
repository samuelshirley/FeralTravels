import { describe, expect, it } from 'vitest';

import {
  isAccountPennyLocked,
  nextStrikeState,
  strikeLockMinutesRemaining,
  STRIKES_BEFORE_LOCK,
  STRIKE_LOCK_MESSAGE,
  STRIKE_LOCK_MINUTES,
} from './strikes';

const NOW = new Date('2026-09-09T12:00:00.000Z');

function run(tiers: Array<'T1' | 'T2' | 'T3'>) {
  let state = { strikes: 0, lockedUntil: null as Date | null };
  for (const tier of tiers) state = nextStrikeState({ tier, strikes: state.strikes, now: NOW });
  return state;
}

describe('nextStrikeState', () => {
  it('locks on the third junk message in a row, and not the second', () => {
    expect(run(['T3', 'T3']).lockedUntil).toBeNull();
    expect(run(['T3', 'T3', 'T3']).lockedUntil).toEqual(
      new Date(NOW.getTime() + STRIKE_LOCK_MINUTES * 60 * 1000)
    );
  });

  it('locks for exactly an hour', () => {
    expect(STRIKE_LOCK_MINUTES).toBe(60);
    expect(STRIKES_BEFORE_LOCK).toBe(3);
  });

  it('is cleared by a real message', () => {
    expect(run(['T3', 'T3', 'T1']).strikes).toBe(0);
    expect(run(['T3', 'T3', 'T1', 'T3', 'T3']).lockedUntil).toBeNull();
  });

  it('does NOT let an adjacent message clear the record', () => {
    /*
     * The hole in the obvious reading of "in a row": if anything not-junk
     * resets the count, a bot alternates junk with "what's the weather" and the
     * third strike never lands. Only a message the app could act on resets it.
     */
    expect(run(['T3', 'T2', 'T3', 'T2', 'T3']).lockedUntil).not.toBeNull();
  });

  it('gives an adjacent message no strike of its own', () => {
    // A real driver asking something real that Penny cannot answer must never
    // accumulate toward a lock.
    expect(run(['T2', 'T2', 'T2', 'T2', 'T2']).lockedUntil).toBeNull();
    expect(run(['T2', 'T2', 'T2']).strikes).toBe(0);
  });

  it('zeroes the count when the lock fires, so the next junk message is not an instant re-lock', () => {
    // Leaving it at three would turn "three in a row" into "one strike,
    // forever" the moment the hour lapsed.
    const locked = run(['T3', 'T3', 'T3']);
    expect(locked.strikes).toBe(0);
    const after = nextStrikeState({ tier: 'T3', strikes: locked.strikes, now: NOW });
    expect(after.lockedUntil).toBeNull();
  });

  it('does not mutate the clock it was given', () => {
    const now = new Date(NOW);
    nextStrikeState({ tier: 'T3', strikes: 2, now });
    expect(now.toISOString()).toBe(NOW.toISOString());
  });
});

describe('isAccountPennyLocked', () => {
  it('is false with no lock', () => {
    expect(isAccountPennyLocked(null, NOW)).toBe(false);
    expect(isAccountPennyLocked(undefined, NOW)).toBe(false);
  });

  it('is false the moment the hour is up, not a tick later', () => {
    expect(isAccountPennyLocked(NOW, NOW)).toBe(false);
    expect(isAccountPennyLocked(new Date(NOW.getTime() - 1), NOW)).toBe(false);
  });

  it('is true while there is time left', () => {
    expect(isAccountPennyLocked(new Date(NOW.getTime() + 1), NOW)).toBe(true);
  });
});

describe('strikeLockMinutesRemaining', () => {
  it('rounds up, and never reads zero', () => {
    expect(strikeLockMinutesRemaining(new Date(NOW.getTime() + 60_000), NOW)).toBe(1);
    expect(strikeLockMinutesRemaining(new Date(NOW.getTime() + 1), NOW)).toBe(1);
    expect(strikeLockMinutesRemaining(new Date(NOW.getTime() + 59 * 60_000), NOW)).toBe(59);
  });
});

describe('the message the driver sees', () => {
  it('states the fact, names the hour, and accuses nobody', () => {
    expect(STRIKE_LOCK_MESSAGE).toBe('Penny is paused for this account for an hour.');
    expect(STRIKE_LOCK_MESSAGE).not.toMatch(/spam|abuse|violat|warn|blocked/i);
  });
});
