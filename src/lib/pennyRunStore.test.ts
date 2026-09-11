/**
 * The run store's own rules. The component test
 * (`ChatPanel.inFlight.test.tsx`) proves the UI reads it; this proves the
 * thing being read is right, and it is where the two properties that only
 * matter under concurrency live: idempotence, and two observers of one turn.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginPennyRun,
  canReplaceTranscript,
  endPennyRun,
  isPennyRunning,
  isTurnInFlight,
  pennyRunKeys,
  reconcilePennyRun,
  resetPennyRuns,
  subscribePennyRuns,
} from './pennyRunStore';

const TRIP = 'trip-1';
const OTHER = 'trip-2';

beforeEach(() => resetPennyRuns());

describe('begin / end', () => {
  it('is false before anything happens', () => {
    expect(isPennyRunning(TRIP)).toBe(false);
  });

  it('tracks a run and clears it', () => {
    beginPennyRun(TRIP, 'k1');
    expect(isPennyRunning(TRIP)).toBe(true);
    endPennyRun(TRIP, 'k1');
    expect(isPennyRunning(TRIP)).toBe(false);
  });

  it('is keyed by trip', () => {
    beginPennyRun(TRIP, 'k1');
    expect(isPennyRunning(OTHER)).toBe(false);
  });

  /**
   * The case the set exists for: the mount that SENT the turn and a later
   * mount that hydrated from the server are both tracking it. Recording it
   * twice must not require ending it twice, or the first observer to finish
   * would leave the indicator stuck on.
   */
  it('is idempotent — two observers of one turn count once', () => {
    beginPennyRun(TRIP, 'k1');
    beginPennyRun(TRIP, 'k1');
    expect(pennyRunKeys(TRIP)).toEqual(['k1']);
    endPennyRun(TRIP, 'k1');
    expect(isPennyRunning(TRIP)).toBe(false);
  });

  /**
   * And the case a boolean would get wrong: a second, genuinely different turn
   * queued behind the first. Finishing the first must not say the trip is idle.
   */
  it('counts two distinct turns separately', () => {
    beginPennyRun(TRIP, 'k1');
    beginPennyRun(TRIP, 'k2');
    endPennyRun(TRIP, 'k1');
    expect(isPennyRunning(TRIP)).toBe(true);
    endPennyRun(TRIP, 'k2');
    expect(isPennyRunning(TRIP)).toBe(false);
  });

  it('ignores an end for a key it never saw', () => {
    beginPennyRun(TRIP, 'k1');
    endPennyRun(TRIP, 'never');
    expect(isPennyRunning(TRIP)).toBe(true);
  });

  it('ignores an empty trip id or turn key rather than tracking a phantom', () => {
    beginPennyRun('', 'k1');
    beginPennyRun(TRIP, '');
    expect(isPennyRunning(TRIP)).toBe(false);
    expect(isPennyRunning('')).toBe(false);
  });
});

describe('subscribers', () => {
  it('fire on a real change and not on a no-op', () => {
    let calls = 0;
    const off = subscribePennyRuns(() => (calls += 1));
    beginPennyRun(TRIP, 'k1');
    expect(calls).toBe(1);
    beginPennyRun(TRIP, 'k1'); // already known
    expect(calls).toBe(1);
    endPennyRun(TRIP, 'nope'); // unknown key
    expect(calls).toBe(1);
    endPennyRun(TRIP, 'k1');
    expect(calls).toBe(2);
    off();
    beginPennyRun(TRIP, 'k2');
    expect(calls).toBe(2);
  });
});

describe('isTurnInFlight', () => {
  /**
   * `queued` counts. A turn waiting behind another is work the user is waiting
   * on; READY is as wrong for it as it is for `running`.
   */
  it('is true for queued and running', () => {
    expect(isTurnInFlight('queued')).toBe(true);
    expect(isTurnInFlight('running')).toBe(true);
  });

  it('is false for everything terminal, and for nothing at all', () => {
    expect(isTurnInFlight('done')).toBe(false);
    expect(isTurnInFlight('error')).toBe(false);
    expect(isTurnInFlight(null)).toBe(false);
    expect(isTurnInFlight(undefined)).toBe(false);
    expect(isTurnInFlight('')).toBe(false);
  });
});

describe('reconcilePennyRun', () => {
  it('records a turn the server says is live', () => {
    reconcilePennyRun(TRIP, { status: 'running', idempotency_key: 'k1' });
    expect(isPennyRunning(TRIP)).toBe(true);
  });

  /**
   * The direction that keeps the indicator honest in the other sense: a store
   * entry whose sender never ran its cleanup (the process was killed mid-turn)
   * would otherwise pin THINKING on forever.
   */
  it('clears a stale entry when the server says the turn is over', () => {
    beginPennyRun(TRIP, 'k1');
    reconcilePennyRun(TRIP, { status: 'done', idempotency_key: 'k1' });
    expect(isPennyRunning(TRIP)).toBe(false);
  });

  it('does nothing without a key, and nothing for no turn at all', () => {
    beginPennyRun(TRIP, 'k1');
    reconcilePennyRun(TRIP, { status: 'done', idempotency_key: null });
    reconcilePennyRun(TRIP, null);
    expect(isPennyRunning(TRIP)).toBe(true);
  });
});

describe('resetPennyRuns', () => {
  it('empties every trip — this is what sign-out calls', () => {
    beginPennyRun(TRIP, 'k1');
    beginPennyRun(OTHER, 'k2');
    resetPennyRuns();
    expect(isPennyRunning(TRIP)).toBe(false);
    expect(isPennyRunning(OTHER)).toBe(false);
  });
});

describe('canReplaceTranscript', () => {
  /**
   * The mount-time turn check reloads the transcript when the turn it was
   * waiting on lands, and `setMessages` REPLACES the array. An optimistic row
   * exists only in client state, so replacing over a live send deletes the
   * driver's own message and the reply Penny is streaming into it — worse than
   * the bug the reload exists to fix.
   */
  it('allows the replace when nothing local is pending', () => {
    expect(canReplaceTranscript([])).toBe(true);
    expect(canReplaceTranscript([{ id: 'm1' }, { id: 'm2', streaming: false }])).toBe(true);
  });

  it('refuses over an optimistic row — a message the server has never seen', () => {
    expect(canReplaceTranscript([{ id: 'm1' }, { id: 'optimistic-172' }])).toBe(false);
  });

  it('refuses over a bubble Penny is still streaming into', () => {
    expect(canReplaceTranscript([{ id: 'm1' }, { id: 'm2', streaming: true }])).toBe(false);
  });

  it('survives rows with no id at all rather than throwing', () => {
    expect(canReplaceTranscript([{}, { id: null }, { id: undefined }])).toBe(true);
  });
});
