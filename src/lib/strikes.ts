/**
 * Strikes — what happens to an account that keeps sending Penny junk.
 *
 * Deterministic, and no model is consulted to apply it: the tier has already
 * been decided by the time this runs, and a second judgement here would be a
 * second thing to get wrong.
 *
 * ── The rule ──
 *
 * Three junk messages IN A ROW and Penny goes quiet for that account for an
 * hour. A real message clears the record.
 *
 * ── Why only a real message clears it ──
 *
 * The obvious reading of "in a row" is that anything not-junk resets the count,
 * and that reading has a hole big enough to walk a bot through: alternate junk
 * and a weather question and the third strike never lands. So the reset is
 * `T1` only — a message the app could actually act on. `T2` is a real driver
 * asking something real that Penny cannot answer, so it earns no strike; it
 * simply leaves the record where it was.
 *
 * ── Why an hour, and why it is not longer ──
 *
 * The population this fires on is mostly not attackers. It is somebody pasting
 * a stack trace to see what happens, or a child with a phone. An hour is enough
 * to make an automated loop pointless and short enough that a curious human is
 * not punished for the evening — and every one of those messages cost $0.0005
 * or nothing, so the lock is about intent rather than about money already lost.
 *
 * Pure: the clock is passed in. `users.penny_locked_until` and
 * `users.penny_strikes` hold the state.
 */

/** The tier a message was sorted into. See `src/lib/pennyGate.ts`. */
export type MessageTier = 'T1' | 'T2' | 'T3';

/** Junk messages in a row before Penny stops answering this account. */
export const STRIKES_BEFORE_LOCK = 3;

/** How long the lock lasts. */
export const STRIKE_LOCK_MINUTES = 60;

/**
 * The one line the driver sees. States the fact and nothing else — no
 * accusation, no lecture, no invitation to argue with it, and it names the hour
 * so the wait is knowable.
 */
export const STRIKE_LOCK_MESSAGE = 'Penny is paused for this account for an hour.';

export interface StrikeState {
  /** Junk messages in a row, after this message. */
  strikes: number;
  /** When Penny starts answering again, or null. */
  lockedUntil: Date | null;
}

/**
 * The account's strike state after one message of `tier`.
 *
 * Returns the WHOLE state rather than an instruction, so the caller writes two
 * columns and has nothing to decide.
 */
export function nextStrikeState(input: {
  tier: MessageTier;
  strikes: number;
  now: Date;
}): StrikeState {
  const { tier, strikes, now } = input;

  // A real message clears the record. Not a lock lift — an account inside its
  // hour cannot get a message judged in the first place, because the lock is
  // checked before the tiering runs.
  if (tier === 'T1') return { strikes: 0, lockedUntil: null };

  // Adjacent. Not junk, so no strike; not actionable, so no reset either.
  if (tier === 'T2') return { strikes, lockedUntil: null };

  const next = strikes + 1;
  if (next < STRIKES_BEFORE_LOCK) return { strikes: next, lockedUntil: null };

  // The third one. Lock, and zero the count: the hour IS the consequence, and
  // leaving the count at three would make every later junk message re-lock
  // instantly — one strike, forever, which is not what "three in a row" means.
  return {
    strikes: 0,
    lockedUntil: new Date(now.getTime() + STRIKE_LOCK_MINUTES * 60 * 1000),
  };
}

/** Is Penny paused for this account right now? */
export function isAccountPennyLocked(lockedUntil: Date | null | undefined, now: Date): boolean {
  if (!lockedUntil) return false;
  return lockedUntil.getTime() > now.getTime();
}

/** Whole minutes left on the lock, floored at 1 so it never reads "0 minutes". */
export function strikeLockMinutesRemaining(lockedUntil: Date, now: Date): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000));
}
